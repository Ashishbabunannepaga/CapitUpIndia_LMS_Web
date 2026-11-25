import { expect, type Page, test } from "@playwright/test";

import { createWorkTask } from "@/server/data/work-tasks";

import { actor, clientAddress, execute, openLocalDb, PASSWORD, queryFirst, retrying, USERS, type LocalDb, type UserKey } from "./fixtures";

// Task Grid: an admin's task is pinned in the agent's My Day header; the
// agent asks a question from there, and the admin sees it in the thread.

test.describe.configure({ mode: "serial" });

let db: LocalDb;
let taskId: number;

test.beforeAll(async () => {
  db = await openLocalDb();
  await execute(db, "delete from work_tasks where title like 'E2E grid %'");
  const admin = await actor(db, "admin");
  const amit = await actor(db, "amit");
  const task = await retrying(() =>
    createWorkTask(db.ctx, admin, {
      title: "E2E grid collect KYC",
      priority: "P1",
      assignee_id: amit.id,
      due_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      tags: "kyc",
    }),
  );
  taskId = task.id;
});

test.afterAll(async () => {
  await execute(db, "delete from work_tasks where title like 'E2E grid %'");
  await db?.dispose();
});

async function signIn(page: Page, user: UserKey) {
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": clientAddress() });
  await page.goto("/login");
  await page.getByLabel("Work email").fill(USERS[user].email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test("the agent sees the admin's urgent task pinned on My Day and asks a question", async ({ page }) => {
  await signIn(page, "amit");
  await page.goto("/my-day");
  // P1 from an admin: the pin opens by itself.
  await expect(page.getByRole("button", { name: /1 task from admin/ })).toBeVisible();
  await expect(page.getByText("Pinned tasks")).toBeVisible();
  await page.getByRole("button", { name: /E2E grid collect KYC/ }).click();
  await expect(page.getByText(`by ${USERS.admin.name}`)).toBeVisible();
  await page.getByLabel("Message").fill("Which documents do they still owe?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Which documents do they still owe?")).toBeVisible();
  const row = await queryFirst<{ n: number }>(db, "select count(*) as n from work_task_messages where task_id = ? and kind = 'message'", taskId);
  expect(row?.n).toBe(1);
});

test("the admin reads the question in the thread and the agent's grid shows the task", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByRole("heading", { name: "E2E grid collect KYC" })).toBeVisible();
  await expect(page.getByText("Which documents do they still owe?")).toBeVisible();
  await expect(page.getByText(/is waiting on your reply/)).toBeVisible();
  await page.getByLabel("Message").fill("PAN and address proof.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("PAN and address proof.")).toBeVisible();

  await page.goto("/tasks?view=given");
  await expect(page.getByRole("link", { name: /E2E grid collect KYC/ })).toBeVisible();
});
