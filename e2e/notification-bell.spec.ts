import { expect, type Page, test } from "@playwright/test";

import { createLead } from "@/server/data/leads";

import { actor, clientAddress, execute, openLocalDb, PASSWORD, retrying, USERS, type LocalDb } from "./fixtures";

// The renewal reminders panel opens from the bell in the sidebar. It is wider
// than the sidebar, so it must float over the page instead of being cut off
// at the sidebar's edge, on a desktop screen and in the phone menu.

test.describe.configure({ mode: "serial" });

let db: LocalDb;
let leadId: number;

test.beforeAll(async () => {
  db = await openLocalDb();
  await execute(db, "delete from leads where client_name like 'Bell %'");
  const amit = await actor(db, "amit");
  leadId = await retrying(() => createLead(db.ctx, amit, { client_name: "Bell Venkatesh Traders", poc_name: "Venkatesh" }));
  for (const days of [1, 10, 30]) {
    await execute(
      db,
      "insert into notifications (user_id, kind, title, body, lead_id) values (?, 'renewal_reminder', ?, ?, ?)",
      amit.id,
      `T-${days} Days: Bell Venkatesh Traders renewal (Life)`,
      "Renews soon",
      leadId,
    );
  }
});

test.afterAll(async () => {
  await execute(db, "delete from notifications where title like '%Bell Venkatesh%'");
  await db?.dispose();
});

async function signIn(page: Page) {
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": clientAddress() });
  await page.goto("/login");
  await page.getByLabel("Work email").fill(USERS.amit.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** The panel's corners are the panel itself, not something drawn over it or cut away. */
async function expectFullyVisible(page: Page) {
  const panel = page.getByText("Renewal reminders", { exact: true }).locator("xpath=../..");
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  const inset = 6;
  for (const [x, y] of [
    [box!.x + inset, box!.y + inset],
    [box!.x + box!.width - inset, box!.y + inset],
    [box!.x + box!.width - inset, box!.y + box!.height - inset],
  ]) {
    const inside = await panel.evaluate((el, [px, py]) => el.contains(document.elementFromPoint(px, py)), [x, y]);
    expect(inside, `point ${Math.round(x)},${Math.round(y)} is covered or clipped`).toBe(true);
  }
}

test("the reminders panel floats over the lead page on a desktop screen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  await page.goto(`/leads/${leadId}`);
  await page.locator("aside").getByRole("button", { name: /Notifications/ }).click();
  await expectFullyVisible(page);
});

test("the reminders panel fits inside the phone menu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto(`/leads/${leadId}`);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Notifications/ }).click();
  await expectFullyVisible(page);
});
