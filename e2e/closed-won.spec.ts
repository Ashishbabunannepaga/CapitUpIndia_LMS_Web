import { expect, type Page, test } from "@playwright/test";

import { addDays, addYears, todayInBusinessTz } from "@/lib/dates";
import { addLeadNote, createLead } from "@/server/data/leads";

import { actor, clientAddress, passTwoFactor, execute, openLocalDb, PASSWORD, queryFirst, retrying, USERS, type LocalDb, type UserKey } from "./fixtures";

// In a real browser: an agent closes a lead by uploading its policy (checked,
// then Closed Won with a client code and next year's renewal date), notes can
// be edited, the year is kept in Policy history with the policy copy, the
// calendar names the real product, and admins export with the closed and
// policy start filters.

test.describe.configure({ mode: "serial" });

async function signIn(page: Page, user: UserKey) {
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": clientAddress() });
  await page.goto("/login");
  await page.getByLabel("Work email").fill(USERS[user].email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await passTwoFactor(page);
  await expect(page).not.toHaveURL(/\/login/);
}

let db: LocalDb;
let leadId: number;
let noteId: number;
const today = todayInBusinessTz();
const due = addDays(today, 12);
const end = addDays(addYears(due, 1), -1);

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

test("picking Closed Won asks for the policy, then closes the lead with a client code", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto(`/leads/${leadId}`);
  await page.getByRole("combobox", { name: "Lead status" }).click();
  await page.getByRole("option", { name: "Closed Won" }).click();
  const dialog = page.getByRole("dialog", { name: "Close with the policy" });
  await dialog.getByLabel(/Policy document/).setInputFiles({
    name: "fire-policy.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% e2e policy\n"),
  });
  await page.screenshot({ path: "test-results/closed-won/1-upload.png" });
  await dialog.getByRole("button", { name: "Upload and check" }).click();
  const review = page.getByRole("dialog", { name: "Check the policy" });
  await expect(review).toBeVisible({ timeout: 30_000 });
  // Waiting for its check, the lead is Closed Awaiting Policy.
  await expect
    .poll(async () => (await queryFirst<{ s: string }>(db, "select pipeline_status s from leads where id = ?", leadId))?.s)
    .toBe("Closed Awaiting Policy");
  await review.getByLabel("Policy start date").fill(due);
  await review.getByLabel(/Policy end date/).fill(end);
  await review.getByLabel(/Premium/).fill("45000");
  await review.getByRole("button", { name: "Re-check" }).click();
  await expect(review.getByText("Policy period")).toBeVisible();
  await page.screenshot({ path: "test-results/closed-won/2-review.png" });
  await review.getByRole("button", { name: "Confirm and mark Closed Won" }).click();
  const done = page.getByRole("dialog", { name: "Closed Won" });
  await expect(done.getByText(/Client code CAP-CLI-\d{4}-\d{4}/)).toBeVisible();
  await page.screenshot({ path: "test-results/closed-won/3-closed-won.png" });
  const after = await queryFirst<{ s: string; d: string; c: string }>(
    db,
    "select pipeline_status s, renewal_date d, client_code c from leads where id = ?",
    leadId,
  );
  expect(after).toMatchObject({ s: "Closed Won", d: end });
  expect(after?.c).toMatch(new RegExp(`^CAP-CLI-${due.slice(0, 4)}-\\d{4}$`));
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

test("the policy year is kept in Policy history with its copy", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto(`/leads/${leadId}?tab=policies`);
  await expect(page.getByText("Checked by hand").or(page.getByText("Policy checked")).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "fire-policy.pdf" })).toBeVisible();
  await page.screenshot({ path: "test-results/closed-won/4-policy-history.png", fullPage: true });
  const tx = await queryFirst<{ id: number; s: string }>(db, "select id, policy_start_date s from lead_transactions where lead_id = ?", leadId);
  expect(tx?.s).toBe(due);
  const doc = await page.request.get(`/leads/${leadId}/policy?t=${tx!.id}`);
  expect(doc.headers()["content-type"]).toBe("application/pdf");
});

test("admins export the won leads by policy start date", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto("/leads");
  // Corporate/retail and the closed outcomes are separate filters that combine.
  await page.getByRole("combobox", { name: "Corporate or retail" }).selectOption("Corporate");
  await expect(page).toHaveURL(/business=Corporate/);
  await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("outcome:won");
  await expect(page).toHaveURL(/business=Corporate.*outcome=won/);
  await page.getByLabel("Policy start from").fill(due);
  await expect(page).toHaveURL(/outcome=won.*start_from=/);
  await expect(page.getByRole("link", { name: "Rollover Fire Pvt Ltd" }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/closed-won/5-export-filters.png" });
  const href = await page.getByRole("link", { name: "Export", exact: true }).getAttribute("href");
  expect(href).toContain("outcome=won");
  const file = await page.request.get(href!);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toContain("spreadsheetml");
});
