import { expect, type Page, test } from "@playwright/test";

import { createLead } from "@/server/data/leads";

import { actor, clientAddress, execute, openLocalDb, PASSWORD, queryFirst, retrying, USERS, type LocalDb, type UserKey } from "./fixtures";

// The real app in a real browser: sign-in, creating a lead, the duplicate
// warning, notes, status changes and what each role can open.

test.describe.configure({ mode: "serial" });

async function signIn(page: Page, user: UserKey, password = PASSWORD) {
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": clientAddress() });
  await page.goto("/login");
  await page.getByLabel("Work email").fill(USERS[user].email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  if (password === PASSWORD) await expect(page).not.toHaveURL(/\/login/);
}

let db: LocalDb;
let nehaLead: number;

async function leadRow(clientName: string) {
  return queryFirst(db, "select * from leads where client_name = ?", clientName);
}

test.beforeAll(async () => {
  db = await openLocalDb();
  await execute(db, "delete from leads where client_name like 'UI %'");
  const neha = await actor(db, "neha");
  nehaLead = await retrying(() => createLead(db.ctx, neha, { client_name: "UI Renee Systems", poc_name: "Rajesh" }));
});

test.afterAll(async () => {
  await db?.dispose();
});

test("signed-out visitors are sent to the login page and brought back after", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": clientAddress() });
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
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": clientAddress() });
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
  // Check through the app, not by polling the database file the Worker is writing to.
  await expect
    .poll(async () => {
      await page.reload();
      return page.getByLabel("Lead status").first().inputValue();
    })
    .toBe("Quoted");
  expect((await leadRow("UI Kaveri Textiles"))?.status).toBe("Quoted");

  const lead = await leadRow("UI Kaveri Textiles");
  const milestones = await queryFirst<{ n: number }>(
    db,
    "select count(*) as n from events where is_system_generated = 1 and lead_id = ?",
    lead!.id,
  );
  expect(milestones?.n).toBe(10);
});

test("the form explains invalid input instead of saving it", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto("/leads/new");
  await page.getByLabel("Client or company name").fill("UI Bad Input Co");
  await page.locator("#poc_contact_number").fill("call me maybe");
  await page.getByRole("button", { name: "Save lead" }).click();
  await expect(page.getByText("Use digits, spaces, + or - only.")).toBeVisible();
  expect(await leadRow("UI Bad Input Co")).toBeNull();
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
  const copy = await leadRow("UI Renee Systems Pvt Ltd");
  expect({ is_duplicate: copy?.is_duplicate, duplicate_label: copy?.duplicate_label }).toEqual({
    is_duplicate: 1,
    duplicate_label: "Duplicate: Already being processed by agent(s) [Neha E2E]",
  });
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

test("an agent plans a task on My Day and ticks it off", async ({ page }) => {
  await signIn(page, "amit");
  await page.getByLabel("Task").fill("UI Call Priya about the quote");
  await page.getByRole("button", { name: "Add task" }).click();
  const box = page.getByLabel('Mark "UI Call Priya about the quote" done');
  await expect(box).toBeVisible();
  await box.check();
  // Confirm through the app first: querying the shared database file while the
  // Worker is still writing makes the Worker's write fail with SQLITE_BUSY.
  await expect
    .poll(async () => {
      await page.reload();
      return page.getByLabel('Mark "UI Call Priya about the quote" not done').isChecked();
    })
    .toBe(true);
  const task = await queryFirst<{ is_completed: number }>(
    db,
    "select is_completed from events where title = ?",
    "UI Call Priya about the quote",
  );
  expect(task?.is_completed).toBe(1);
});

test("the admin adds a person who can then sign in, and disabling them shuts them out", async ({ page, browser }) => {
  await execute(db, "delete from user where email = 'ravi@e2e.test'");
  await signIn(page, "admin");
  await page.goto("/admin/team");
  await page.getByLabel("Full name").fill("Ravi E2E");
  await page.getByLabel("Work email").fill("Ravi@E2E.test");
  await page.getByLabel("First password").fill("ravi-Password-1");
  await page.getByRole("button", { name: "Add person" }).click();
  await expect(page.getByText("Account created.")).toBeVisible();
  await expect(page.getByRole("cell", { name: "ravi@e2e.test" })).toBeVisible();

  const ravi = await browser.newPage();
  await ravi.setExtraHTTPHeaders({ "cf-connecting-ip": clientAddress() });
  await ravi.goto("/login");
  await ravi.getByLabel("Work email").fill("ravi@e2e.test");
  await ravi.getByLabel("Password").fill("ravi-Password-1");
  await ravi.getByRole("button", { name: "Sign in" }).click();
  await expect(ravi).toHaveURL(/\/my-day/);

  const row = page.getByRole("row").filter({ hasText: "ravi@e2e.test" });
  await row.getByRole("button", { name: "Disable" }).click();
  await expect(row.getByText("Disabled")).toBeVisible();

  // Their open session ends on the next request.
  await ravi.goto("/leads");
  await expect(ravi).toHaveURL(/\/login/);
  await ravi.close();
});

test("an admin cannot demote or disable themselves from the team page", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto("/admin/team");
  const own = page.getByRole("row").filter({ hasText: USERS.admin.email });
  await expect(own.getByLabel(`Role for ${USERS.admin.name}`)).toBeDisabled();
  await expect(own.getByRole("button", { name: "Disable" })).toHaveCount(0);
});

test("first-run setup is closed once the team exists", async ({ request }) => {
  const response = await request.get("/setup");
  expect(response.status()).toBe(404);
});

test("signing out ends the session", async ({ page }) => {
  await signIn(page, "amit");
  await expect(page).toHaveURL(/\/my-day/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/my-day");
  await expect(page).toHaveURL(/\/login/);
});
