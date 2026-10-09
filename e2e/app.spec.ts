import { expect, type Page, test } from "@playwright/test";

import { adminClient, PASSWORD, USERS, userId, type UserKey } from "./fixtures";

// The real app in a real browser: sign-in, creating a lead, the duplicate
// warning, notes, status changes and what each role can open.

test.describe.configure({ mode: "serial" });

async function signIn(page: Page, user: UserKey, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(USERS[user].email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  if (password === PASSWORD) await expect(page).not.toHaveURL(/\/login/);
}

let nehaLead: number;

test.beforeAll(async () => {
  const admin = adminClient();
  await admin.from("leads").delete().like("client_name", "UI %");
  const { data, error } = await admin
    .from("leads")
    .insert({ client_name: "UI Renee Systems", assigned_agent_id: await userId("neha"), poc_name: "Rajesh" })
    .select("id")
    .single();
  if (error) throw error;
  nehaLead = data.id;
});

test("signed-out visitors are sent to the login page and brought back after", async ({ page }) => {
  await page.goto("/leads?view=cards");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Work email").fill(USERS.amit.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/leads\?view=cards/);
});

test("a wrong password gets one plain message", async ({ page }) => {
  await signIn(page, "amit", "not-the-password");
  await expect(page.getByText("Incorrect email or password.")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("a login link cannot bounce the user to another site", async ({ page }) => {
  await page.goto("/login?next=" + encodeURIComponent("/\\evil.example"));
  await page.getByLabel("Work email").fill(USERS.amit.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/my-day/);
});

test("an agent creates a lead, writes a note and moves its status", async ({ page }) => {
  await signIn(page, "amit");
  await expect(page).toHaveURL(/\/my-day/);

  await page.goto("/leads/new");
  await page.getByLabel("Client or company name").fill("UI Kaveri Textiles");
  await page.locator("#poc_name").fill("Priya");
  await page.locator("#poc_contact_number").fill("98450 12345");
  await page.locator("#poc_email_id").fill("Priya@Kaveri.IN");
  await page.locator("#renewal_date").fill("2030-03-15");
  await page.getByRole("button", { name: "Save lead" }).click();

  await expect(page.getByText("Lead saved.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "UI Kaveri Textiles" })).toBeVisible();
  await expect(page.getByText("priya@kaveri.in")).toBeVisible();

  await page.getByPlaceholder("Call notes, visit feedback or quote details").fill("Met Priya, quote by Friday");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText("Met Priya, quote by Friday")).toBeVisible();
  await expect(page.getByText(USERS.amit.name).first()).toBeVisible();

  await page.getByLabel("Lead status").first().selectOption("Quoted");
  await expect
    .poll(async () => {
      const { data } = await adminClient().from("leads").select("status").eq("client_name", "UI Kaveri Textiles").single();
      return data?.status;
    })
    .toBe("Quoted");

  const { data: events } = await adminClient()
    .from("events")
    .select("milestone")
    .eq("is_system_generated", true)
    .in("lead_id", (await adminClient().from("leads").select("id").eq("client_name", "UI Kaveri Textiles")).data!.map((l) => l.id));
  expect(events).toHaveLength(10);
});

test("the form explains invalid input instead of saving it", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto("/leads/new");
  await page.getByLabel("Client or company name").fill("UI Bad Input Co");
  await page.locator("#poc_contact_number").fill("call me maybe");
  await page.getByRole("button", { name: "Save lead" }).click();
  await expect(page.getByText("Use digits, spaces, + or - only.")).toBeVisible();
  const { count } = await adminClient()
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("client_name", "UI Bad Input Co");
  expect(count).toBe(0);
});

test("creating a company another agent owns shows who has it", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto("/leads/new");
  await page.getByLabel("Client or company name").fill("UI Renee Systems Pvt Ltd");
  await expect(page.getByText("Handled by Neha E2E")).toBeVisible();
  await expect(page.getByText("Ask your admin before contacting them")).toBeVisible();

  // Saving needs an explicit confirmation, and the copy is flagged for review.
  await page.getByRole("button", { name: "Save lead" }).click();
  await expect(page).toHaveURL(/\/leads\/new/);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Save lead" }).click();
  await expect(page.getByText("Lead saved.")).toBeVisible();
  const { data } = await adminClient()
    .from("leads")
    .select("is_duplicate, duplicate_label")
    .eq("client_name", "UI Renee Systems Pvt Ltd")
    .single();
  expect(data).toEqual({ is_duplicate: true, duplicate_label: "Duplicate: Already being processed by agent(s) [Neha E2E]" });
});

test("an agent cannot open another agent's lead or the admin pages", async ({ page }) => {
  await signIn(page, "amit");
  await expect(page).toHaveURL(/\/my-day/);
  const response = await page.goto(`/leads/${nehaLead}`);
  expect(response?.status()).toBe(404);
  await expect(page.getByText("Rajesh")).toHaveCount(0);

  await page.goto("/leads");
  await expect(page.getByText("UI Kaveri Textiles").first()).toBeVisible();
  await expect(page.getByText("UI Renee Systems", { exact: true })).toHaveCount(0);

  await page.goto("/admin/team");
  await expect(page).not.toHaveURL(/\/admin\/team/);
});

test("the admin sees every agent's leads", async ({ page }) => {
  await signIn(page, "admin");
  await expect(page).toHaveURL(/\/my-day/);
  await page.goto("/leads?q=UI");
  await expect(page.getByText("UI Kaveri Textiles").first()).toBeVisible();
  await expect(page.getByText("UI Renee Systems", { exact: true }).first()).toBeVisible();
  const response = await page.goto(`/leads/${nehaLead}`);
  expect(response?.status()).toBe(200);
});

test("signing out ends the session", async ({ page }) => {
  await signIn(page, "amit");
  await expect(page).toHaveURL(/\/my-day/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/my-day");
  await expect(page).toHaveURL(/\/login/);
});
