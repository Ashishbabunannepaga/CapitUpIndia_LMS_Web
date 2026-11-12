import { expect, type Page, test } from "@playwright/test";

import { createLead } from "@/server/data/leads";

import { actor, clientAddress, execute, openLocalDb, PASSWORD, queryFirst, retrying, USERS, type LocalDb, type UserKey } from "./fixtures";

// The agent and admin feature batch in a real browser: one Add lead page,
// the floating "+", the lead's History tab and tags, bulk reassign, the audit
// log, the offline bar and "View as agent".

test.describe.configure({ mode: "serial" });

async function signIn(page: Page, user: UserKey) {
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": clientAddress() });
  await page.goto("/login");
  await page.getByLabel("Work email").fill(USERS[user].email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

let db: LocalDb;
let first: number;
let second: number;

test.beforeAll(async () => {
  db = await openLocalDb();
  await execute(db, "delete from leads where client_name like 'Batch %'");
  const amit = await actor(db, "amit");
  first = await retrying(() => createLead(db.ctx, amit, { client_name: "Batch First Co", poc_name: "Meera", poc_contact_number: "98450 11111" }));
  second = await retrying(() => createLead(db.ctx, amit, { client_name: "Batch Second Co" }));
});

test.afterAll(async () => {
  await db?.dispose();
});

test("AI intake and the manual form are one Add lead page", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto("/intake");
  await expect(page).toHaveURL(/\/leads\/new$/);
  await expect(page.getByRole("heading", { name: "Add lead" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "AI intake" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Add manually" }).click();
  await expect(page.getByLabel("Client or company name")).toBeVisible();
  // No floating "+" on the page that already is the form.
  await expect(page.getByRole("button", { name: "Add a lead" })).toHaveCount(0);
});

test("the floating + captures a lead from any page", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto("/calendar");
  await page.getByRole("button", { name: "Add a lead" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a lead" });
  await dialog.getByRole("tab", { name: "Add manually" }).click();
  await dialog.getByLabel("Client or company name").fill("Batch Floating Co");
  await dialog.getByRole("button", { name: "Save lead" }).click();
  await expect(page.getByRole("heading", { name: "Batch Floating Co" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a lead page shows tags, WhatsApp, copy summary and its history", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto(`/leads/${first}`);
  await expect(page.getByRole("link", { name: "WhatsApp 98450 11111" })).toHaveAttribute("href", "https://wa.me/919845011111");
  await expect(page.getByRole("button", { name: "Copy summary" })).toBeVisible();
  await page.getByRole("button", { name: "+ Hot" }).click();
  await expect(page.getByRole("button", { name: "Hot", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await queryFirst(db, "select count(*) as n from lead_tags where lead_id = ?", first))?.n).toBe(1);
  await page.getByRole("link", { name: "History" }).click();
  await expect(page).toHaveURL(/tab=history/);
  await expect(page.getByText("Tags: Hot")).toBeVisible();
  await expect(page.getByText("Created the lead for Amit")).toBeVisible();
});

test("going offline shows the offline bar", async ({ page, context }) => {
  await signIn(page, "amit");
  await page.goto("/my-day");
  await context.setOffline(true);
  await expect(page.getByText("You're offline.")).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText("You're offline.")).toHaveCount(0);
});

test("an admin reassigns several leads at once and sees it in the audit log", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto("/leads?q=Batch");
  await page.getByRole("checkbox", { name: "Select Batch First Co" }).check();
  await page.getByRole("checkbox", { name: "Select Batch Second Co" }).check();
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByLabel("Reassign to").selectOption({ label: USERS.neha.name });
  await page.getByRole("button", { name: "Reassign" }).click();
  await expect(page.getByText("Reassigned 2 leads.")).toBeVisible();
  const nehaId = (await queryFirst<{ id: string }>(db, "select id from profiles where email = ?", USERS.neha.email))!.id;
  for (const id of [first, second]) {
    expect((await queryFirst<{ assigned_agent_id: string }>(db, "select assigned_agent_id from leads where id = ?", id))?.assigned_agent_id).toBe(
      nehaId,
    );
  }
  await page.goto(`/admin/audit?lead=${first}`);
  await expect(page.getByRole("cell", { name: /Assigned agent\s*Amit.*→\s*Neha/ }).first()).toBeVisible();
});

test("an admin views an agent's My Day read-only", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto("/admin/team");
  await page
    .getByRole("row", { name: new RegExp(USERS.neha.email) })
    .getByRole("link", { name: "View as agent" })
    .click();
  await expect(page.getByText(`You are seeing ${USERS.neha.name}'s My Day`)).toBeVisible();
  // The page's own buttons that write are gone (the sidebar still links to Add lead).
  await expect(page.getByRole("main").getByRole("link", { name: "Add lead", exact: true })).toHaveCount(0);
  await expect(page.getByRole("main").getByPlaceholder(/task/i)).toHaveCount(0);
});

test("agents cannot open the audit log or another agent's My Day", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto("/admin/audit");
  await expect(page).toHaveURL(/\/my-day/);
  const nehaId = (await queryFirst<{ id: string }>(db, "select id from profiles where email = ?", USERS.neha.email))!.id;
  await page.goto(`/admin/team/${nehaId}/view`);
  await expect(page).toHaveURL(/\/my-day/);
  const response = await page.request.get("/admin/analytics/renewal-report");
  expect(response.status()).toBe(403);
});
