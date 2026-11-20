import { expect, type Page, test } from "@playwright/test";

import { addDays, todayInBusinessTz } from "@/lib/dates";
import { createLead } from "@/server/data/leads";

import { actor, clientAddress, execute, openLocalDb, PASSWORD, queryFirst, retrying, USERS, type LocalDb, type UserKey } from "./fixtures";

// Ash (2026-11-17): agents edit the "Lead notes" field in place, repeated
// "[AI Import Update]" lines show once, and a won lead with last year's date
// is not shown as overdue.

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
let wonId: number;
const IMPORT_LINE = "[AI Import Update: Tagged as Prospect]";

test.beforeAll(async () => {
  db = await openLocalDb();
  await execute(db, "delete from leads where client_name like 'NotesField %'");
  const amit = await actor(db, "amit");
  leadId = await retrying(() =>
    createLead(db.ctx, amit, {
      client_name: "NotesField Motor Pvt Ltd",
      status: "Prospect",
      notes: ["Vehicle Type: WC", IMPORT_LINE, IMPORT_LINE, IMPORT_LINE].join("\n"),
    }),
  );
  wonId = await retrying(() => createLead(db.ctx, amit, { client_name: "NotesField Won Pvt Ltd", status: "Quoted" }));
  const past = addDays(todayInBusinessTz(), -20);
  await execute(db, `update leads set pipeline_status = 'Closed Won', renewal_date = '${past}' where id = ${wonId}`);
});

test.afterAll(async () => {
  await db?.dispose();
});

test("an agent edits the lead notes in place and the import repeats are gone", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto(`/leads/${leadId}`);
  const panel = page.locator("section", { has: page.getByRole("heading", { name: "Lead notes" }) });
  await expect(panel.getByText(IMPORT_LINE)).toHaveCount(1);
  await panel.getByRole("button", { name: "Edit" }).click();
  await panel.getByLabel("Lead notes").fill("Vehicle Type: WC\nOwner wants a quote by Friday");
  await panel.getByRole("button", { name: "Save notes" }).click();
  await expect(panel.getByText("Owner wants a quote by Friday")).toBeVisible();
  const row = await queryFirst<{ notes: string }>(db, `select notes from leads where id = ${leadId}`);
  expect(row?.notes).toBe("Vehicle Type: WC\nOwner wants a quote by Friday");
});

test("a won client whose renewal date passed without a new policy is overdue again", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto("/leads?renewal=overdue");
  await expect(page.getByText("NotesField Won Pvt Ltd").first()).toBeVisible();
});
