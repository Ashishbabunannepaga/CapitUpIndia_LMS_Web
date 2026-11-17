import { expect, type Page, test } from "@playwright/test";

import { addDays, addYears, todayInBusinessTz } from "@/lib/dates";
import { addLeadNote, createLead } from "@/server/data/leads";

import { actor, clientAddress, execute, openLocalDb, PASSWORD, queryFirst, retrying, USERS, type LocalDb, type UserKey } from "./fixtures";

// Ash's corrections in a real browser: closing a lead asks for next year's
// renewal date, notes can be edited, won leads get transaction details with
// the policy copy, the calendar names the real product, and admins export
// with the closed and policy start filters.

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
let leadId: number;
let noteId: number;
const today = todayInBusinessTz();
const due = addDays(today, 12);

test.beforeAll(async () => {
  db = await openLocalDb();
  await execute(db, "delete from leads where client_name like 'Rollover %'");
  const amit = await actor(db, "amit");
  leadId = await retrying(() =>
    createLead(db.ctx, amit, {
      client_name: "Rollover Fire Pvt Ltd",
      policy_product: "Fire or Property",
      business_type: "Corporate",
      renewal_date: due,
      status: "Quoted",
    }),
  );
  noteId = (await retrying(() => addLeadNote(db.ctx, amit, leadId, "Quote sent on Monday"))).id;
});

test.afterAll(async () => {
  await db?.dispose();
});

test("the calendar names the renewal by its product, not GMC", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto("/calendar");
  await expect(page.getByRole("button", { name: "Corporate Renewal" })).toBeVisible();
  if (due.slice(0, 7) !== today.slice(0, 7)) await page.getByRole("button", { name: "Next month" }).click();
  // The day cell's tile says "1 Fire", not "1 GMC".
  await page.getByRole("button").filter({ hasText: /\d Fire/ }).first().click();
  await expect(page.getByText(/Fire · Corporate Renewal/)).toBeVisible();
});

test("closing a lead asks to verify next year's renewal date", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto(`/leads/${leadId}`);
  await page.getByRole("combobox", { name: "Lead status" }).click();
  await page.getByRole("option", { name: "Renewed" }).click();
  const dialog = page.getByRole("dialog", { name: "Verify the next renewal date" });
  await expect(dialog.getByLabel("Next renewal date")).toHaveValue(addYears(due, 1));
  await page.screenshot({ path: "test-results/closed-won/1-verify-date.png" });
  await dialog.getByRole("button", { name: "Mark Renewed and save date" }).click();
  await expect
    .poll(async () => (await queryFirst<{ s: string; d: string }>(db, "select lead_status s, renewal_date d from leads where id = ?", leadId)))
    .toEqual({ s: "Renewed", d: addYears(due, 1) });
});

test("the writer edits their note in place", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto(`/leads/${leadId}`);
  await page.getByRole("button", { name: "Edit note" }).click();
  await page.getByLabel("Note text").fill("Quote sent on Tuesday");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByText("Quote sent on Tuesday")).toBeVisible();
  await expect(page.getByText("· edited")).toBeVisible();
  expect((await queryFirst<{ c: string }>(db, "select content c from lead_notes where id = ?", noteId))?.c).toBe("Quote sent on Tuesday");
});

test("a renewed lead records its transaction and the received policy", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto(`/leads/${leadId}`);
  const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Transaction details" }) });
  await expect(panel.getByLabel("Transaction date")).toHaveValue(today);
  await panel.getByLabel("Policy start date").fill(due);
  await panel.getByLabel("Policy Received").check();
  await panel.getByLabel(/Upload the policy/).setInputFiles({
    name: "fire-policy.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% e2e policy\n"),
  });
  await panel.getByRole("button", { name: "Save transaction" }).click();
  await expect(panel.getByRole("link", { name: "fire-policy.pdf" })).toBeVisible();
  await page.screenshot({ path: "test-results/closed-won/2-lead-page.png", fullPage: true });
  const tx = await queryFirst<{ id: number; s: string }>(db, "select id, policy_start_date s from lead_transactions where lead_id = ?", leadId);
  expect(tx?.s).toBe(due);
  const doc = await page.request.get(`/leads/${leadId}/policy?t=${tx!.id}`);
  expect(doc.headers()["content-type"]).toBe("application/pdf");
});

test("admins export the won leads by policy start date", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto("/leads");
  await page.getByRole("combobox", { name: "Closed" }).selectOption("won");
  await expect(page).toHaveURL(/outcome=won/);
  await page.getByLabel("Policy start from").fill(due);
  await expect(page).toHaveURL(/outcome=won.*start_from=/);
  await expect(page.getByRole("link", { name: "Rollover Fire Pvt Ltd" }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/closed-won/3-export-filters.png" });
  const href = await page.getByRole("link", { name: "Export" }).getAttribute("href");
  expect(href).toContain("outcome=won");
  const file = await page.request.get(href!);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toContain("spreadsheetml");
});
