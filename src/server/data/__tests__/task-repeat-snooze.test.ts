import { vi } from "vitest";
vi.mock("server-only", () => ({}));

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { nextRepeatDue } from "@/lib/work-tasks";
import { workTasks } from "../../db/schema";
import { deliverTaskDueReminders } from "../task-reminders";
import { createWorkTask, listTasks, setWorkTaskStatus, snoozeWorkTask } from "../work-tasks";
import { testWorld } from "./helpers";

describe("nextRepeatDue", () => {
  const now = new Date("2030-01-01T00:00:00Z");
  it("keeps the time of day and moves on until it is in the future", () => {
    expect(nextRepeatDue("2030-01-10T12:30:00.000Z", "daily", now)).toBe("2030-01-11T12:30:00.000Z");
    expect(nextRepeatDue("2030-01-10T12:30:00.000Z", "weekly", now)).toBe("2030-01-17T12:30:00.000Z");
    expect(nextRepeatDue("2029-12-20T12:30:00.000Z", "weekly", now)).toBe("2030-01-03T12:30:00.000Z");
  });
  it("clamps month ends", () => {
    expect(nextRepeatDue("2030-01-31T12:30:00.000Z", "monthly", now)).toBe("2030-02-28T12:30:00.000Z");
  });
});

describe("repeating and snoozed tasks", () => {
  let w: Awaited<ReturnType<typeof testWorld>>;
  beforeAll(async () => {
    w = await testWorld();
  });
  afterAll(() => w.dispose());

  it("needs a due date to repeat", async () => {
    await expect(createWorkTask(w.ctx, w.admin, { title: "MIS", repeat: "monthly", assignee_id: w.amit.id })).rejects.toThrow(/due date/);
  });

  it("creates the next one once when done, even if reopened and done again", async () => {
    const due = new Date(Date.now() + 3_600_000).toISOString();
    const task = await createWorkTask(w.ctx, w.admin, { title: "Weekly pipeline", repeat: "weekly", due_at: due, assignee_id: w.amit.id, tags: "review" });
    await setWorkTaskStatus(w.ctx, w.amit, task.id, "done");
    await setWorkTaskStatus(w.ctx, w.amit, task.id, "todo");
    await setWorkTaskStatus(w.ctx, w.amit, task.id, "done");
    const copies = (await listTasks(w.ctx, w.amit)).filter((t) => t.title === "Weekly pipeline" && t.id !== task.id);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ repeat: "weekly", status: "todo", assignee_id: w.amit.id, created_by: w.admin.id, tags: ["review"] });
    expect(Date.parse(copies[0].due_at!) - Date.parse(due)).toBe(7 * 86_400_000);
  });

  it("pauses reminders while snoozed, and only the assignee can snooze", async () => {
    const at = new Date("2030-03-06T06:00:00Z"); // Wednesday 11:30 IST
    const task = await createWorkTask(w.ctx, w.admin, { title: "Call Zenith", priority: "P1", due_at: "2030-03-06T05:00:00Z", assignee_id: w.amit.id });
    await expect(snoozeWorkTask(w.ctx, w.admin, task.id, new Date(at.getTime() + 3_600_000), at)).rejects.toThrow();
    await snoozeWorkTask(w.ctx, w.amit, task.id, new Date(at.getTime() + 3_600_000), at);
    await deliverTaskDueReminders(w.ctx, at);
    let row = await w.ctx.db.query.workTasks.findFirst({ where: eq(workTasks.id, task.id) });
    expect(row?.reminder_stage).toBe(0);
    await deliverTaskDueReminders(w.ctx, new Date(at.getTime() + 2 * 3_600_000));
    row = await w.ctx.db.query.workTasks.findFirst({ where: eq(workTasks.id, task.id) });
    expect(row?.reminder_stage).toBeGreaterThanOrEqual(3);
  });
});
