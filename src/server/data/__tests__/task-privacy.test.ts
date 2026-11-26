import { vi } from "vitest";
vi.mock("server-only", () => ({}));

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createUser } from "../users";
import { createWorkTask, getTaskThread, listTasks, postTaskMessage, updateWorkTask } from "../work-tasks";
import { testWorld } from "./helpers";

// A task's conversation is only for the people on it: the one who gave it and
// the one it is for. Other agents and other admins don't see it.
describe("task privacy", () => {
  let w: Awaited<ReturnType<typeof testWorld>>;
  beforeAll(async () => {
    w = await testWorld();
  });
  afterAll(() => w.dispose());

  it("hides a task between an admin and an agent from a second admin and other agents", async () => {
    const other = await createUser(w.ctx, w.admin, { email: "ravi@capitup.test", fullName: "Ravi Admin", password: "correct-horse-9", role: "ADMIN" });
    const task = await createWorkTask(w.ctx, w.admin, { title: "Zenith quote", assignee_id: w.amit.id });
    await postTaskMessage(w.ctx, w.amit, task.id, { body: "On it", via: "text" });

    expect((await listTasks(w.ctx, w.admin)).map((t) => t.id)).toContain(task.id);
    expect((await listTasks(w.ctx, w.amit)).map((t) => t.id)).toContain(task.id);
    expect((await listTasks(w.ctx, w.neha)).map((t) => t.id)).not.toContain(task.id);
    expect((await listTasks(w.ctx, other)).map((t) => t.id)).not.toContain(task.id);
    expect(await getTaskThread(w.ctx, other, task.id)).toBeNull();
    await expect(postTaskMessage(w.ctx, other, task.id, { body: "hi", via: "text" })).rejects.toThrow();
    await expect(updateWorkTask(w.ctx, other, task.id, { title: "x" })).rejects.toThrow();
  });

  it("hides a task an agent raised to one admin from the other admins", async () => {
    const task = await createWorkTask(w.ctx, w.neha, { title: "Discount for Acme", assignee_id: w.admin.id });
    const others = (await listTasks(w.ctx, w.amit)).map((t) => t.id);
    expect(others).not.toContain(task.id);
    expect((await listTasks(w.ctx, w.admin)).map((t) => t.id)).toContain(task.id);
  });
});
