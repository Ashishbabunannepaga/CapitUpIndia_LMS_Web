import { expect, type Page, test } from "@playwright/test";

import { createLead } from "@/server/data/leads";

import { actor, clientAddress, execute, openLocalDb, passTwoFactor, PASSWORD, queryFirst, retrying, USERS, type LocalDb, type UserKey } from "./fixtures";

// Fields filled the way people really fill them: numbers pasted from
// WhatsApp with +91 and spaces, amounts written "Rs. 1,25,000/-", emails in
// capitals, old leads whose saved number is a landline. These caught a phone
// field that cut "98450 12345" short before cleaning it (2026-11-27).

test.describe.configure({ mode: "serial" });

async function signIn(page: Page, user: UserKey, email: string = USERS[user].email) {
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": clientAddress() });
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await passTwoFactor(page);
  await expect(page).not.toHaveURL(/\/login/);
}

let db: LocalDb;
const lead = (name: string) =>
  queryFirst<{ id: number; poc_contact_number: string; poc2_contact_number: string; poc_email_id: string; premium_inr: number | null }>(
    db,
    "select id, poc_contact_number, poc2_contact_number, poc_email_id, premium_inr from leads where client_name = ?",
    name,
  );

test.beforeAll(async () => {
  db = await openLocalDb();
  await execute(db, "delete from leads where client_name like 'Paste %'");
});

test.afterAll(async () => {
  await db?.dispose();
});

test("signing in works with the email in capitals", async ({ page }) => {
  await signIn(page, "amit", USERS.amit.email.toUpperCase());
});

test("a new lead takes pasted +91 numbers, a rupee amount with Rs. and /-, and a capitalised email", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto("/leads/new?mode=manual");
  await page.getByLabel("Client or company name").fill("Paste Kaveri Mills");
  await page.locator("#lead_source").selectOption("Referral");
  await page.locator("#policy_product").selectOption({ index: 1 });
  await page.locator("#poc_name").fill("Meera");
  const phone = page.locator("#poc_contact_number");
  await phone.fill("+91 98765 43210");
  await expect(phone).toHaveValue("9876543210");
  await page.locator("#poc2_contact_number").fill("098765 43211");
  await expect(page.locator("#poc2_contact_number")).toHaveValue("9876543211");
  await page.locator("#poc_email_id").fill("Meera@PasteMills.IN");
  await page.locator("#premium_inr").fill("Rs. 1,25,000/-");
  await page.locator("#renewal_date").fill("2031-03-15");
  await page.getByRole("button", { name: "Save lead" }).click();
  await expect(page.getByText("Lead saved.")).toBeVisible();

  const row = await lead("Paste Kaveri Mills");
  expect(row).toMatchObject({ poc_contact_number: "9876543210", poc2_contact_number: "9876543211", poc_email_id: "meera@pastemills.in", premium_inr: 125000 });
});

test("searching the leads list with +91 finds a number saved as 10 digits", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto("/leads");
  await page.getByLabel("Search leads").fill("+91 98765 43210");
  await page.getByLabel("Search leads").press("Enter");
  await expect(page.getByText("Paste Kaveri Mills").first()).toBeVisible();
});

test("a pasted number in Add contact is cleaned the same way", async ({ page }) => {
  const row = await lead("Paste Kaveri Mills");
  await signIn(page, "amit");
  await page.goto(`/leads/${row!.id}`);
  // Both contact slots are taken, so the new one goes to the lead's contacts list.
  await page.getByRole("button", { name: "Add contact" }).click();
  await page.locator("#contact-name").fill("Ravi");
  const phone = page.locator("#contact-phone");
  await phone.fill("+91-98450-99999");
  await expect(phone).toHaveValue("9845099999");
});

test("an old lead with a landline shows it as saved, and asks for a mobile before saving", async ({ page }) => {
  const amit = await actor(db, "amit");
  const id = await retrying(() => createLead(db.ctx, amit, { client_name: "Paste Landline Co", poc_name: "Office", poc_contact_number: "040 2311 0640" }));
  await signIn(page, "amit");
  await page.goto(`/leads/${id}/edit`);
  const phone = page.locator("#poc_contact_number");
  await expect(phone).toHaveValue("040 2311 0640");
  await page.getByRole("button", { name: /Save/ }).first().click();
  expect(await phone.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
  expect((await lead("Paste Landline Co"))?.poc_contact_number).toBe("040 2311 0640");

  await phone.fill("98480 22338");
  await expect(phone).toHaveValue("9848022338");
  await page.getByRole("button", { name: /Save/ }).first().click();
  await expect.poll(async () => (await lead("Paste Landline Co"))?.poc_contact_number).toBe("9848022338");
});

test("an admin pastes a team member's WhatsApp number with +91", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto("/admin/whatsapp");
  const field = page.getByLabel(`${USERS.neha.name}'s WhatsApp number`);
  await field.fill("+91 90000 11111");
  await expect(field).toHaveValue("9000011111");
  await field.locator("xpath=ancestor::form").getByRole("button", { name: "Save" }).click();
  await expect
    .poll(async () => (await queryFirst<{ p: string }>(db, "select whatsapp_phone p from profiles where email = ?", USERS.neha.email))?.p)
    .toBe("919000011111");
  await page.reload();
  await expect(page.getByLabel(`${USERS.neha.name}'s WhatsApp number`)).toHaveValue("9000011111");
});

test("closing with the policy takes the premium as Rs. 45,000/-", async ({ page }) => {
  const amit = await actor(db, "amit");
  const renewal = "2031-01-10";
  const id = await retrying(() =>
    createLead(db.ctx, amit, { client_name: "Paste Policy Co", policy_product: "Fire or Property", business_type: "Corporate", renewal_date: renewal, status: "Quoted" }),
  );
  await signIn(page, "amit");
  await page.goto(`/leads/${id}`);
  await page.getByRole("combobox", { name: "Lead status" }).click();
  await page.getByRole("option", { name: "Closed Won" }).click();
  const dialog = page.getByRole("dialog", { name: "Close with the policy" });
  await dialog.getByLabel(/Policy document/).setInputFiles({ name: "policy.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% e2e\n") });
  await dialog.getByRole("button", { name: "Upload and check" }).click();
  const review = page.getByRole("dialog", { name: "Check the policy" });
  await expect(review).toBeVisible({ timeout: 30_000 });
  await review.getByLabel("Policy start date").fill(renewal);
  await review.getByLabel(/Policy end date/).fill("2032-01-09");
  await review.getByLabel(/Premium/).fill("Rs. 45,000/-");
  await review.getByRole("button", { name: "Re-check" }).click();
  await expect(review.getByText("Enter the premium as a number.")).toHaveCount(0);
  await review.getByRole("button", { name: "Confirm and mark Closed Won" }).click();
  await expect(page.getByRole("dialog", { name: "Closed Won" })).toBeVisible();
  const row = await queryFirst<{ premium: number }>(db, "select premium from lead_transactions where lead_id = ? order by id desc", id);
  expect(row?.premium).toBe(45000);
});
