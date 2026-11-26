import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import { notifications, workTaskMessages, workTasks } from "../../db/schema";
import { deliverTaskDueReminders, inWorkingHours, reminderStageAt } from "../task-reminders";
import { createWorkTask } from "../work-tasks";
import { testWorld } from "./helpers";

// Due-time reminders for Task Grid: the ladder, working hours, no bursts, no repeats.

let w: Awaited<ReturnType<typeof testWorld>>;

beforeAll(async () => {
  w = await testWorld();
});
afterAll(async () => {
  await w.dispose();
});

// 06:30 UTC = 12:00 IST (working hours); 18:30 UTC = 00:00 IST (night).
const NOON = new Date("2030-03-06T06:30:00.000Z");
const NIGHT = new Date("2030-03-06T18:30:00.000Z");
const shift = (at: Date, minutes: number) => new Date(at.getTime() + minutes * 60_000);

async function taskDue(actorKey: "admin" | "amit", assignee: string, priority: "P1" | "P2" | "P3", dueAt: Date, title: string) {
  const task = await createWorkTask(w.ctx, w[actorKey], { title, priority, assignee_id: assignee });
  await w.ctx.db.update(workTasks).set({ due_at: dueAt.toISOString() }).where(eq(workTasks.id, task.id));
  return task;
}

const bells = (userId: string, taskId: number) =>
  w.ctx.db
    .select({ title: notifications.title })
    .from(notifications)
    .where(and(eq(notifications.user_id, userId), eq(notifications.task_id, taskId)));

describe("reminder ladder", () => {
  it("knows working hours in India", () => {
    expect(inWorkingHours(NOON)).toBe(true);
    expect(inWorkingHours(NIGHT)).toBe(false);
  });

  it("climbs faster for P1, holds nudges at night and stops personal to-dos at the nudge", () => {
    const due = NOON.toISOString();
    const p1 = { priority: "P1" as const, due_at: due, kind: "assigned" as const };
    expect(reminderStageAt(p1, shift(NOON, -121))).toBe(0);
    expect(reminderStageAt(p1, shift(NOON, -120))).toBe(1);
    expect(reminderStageAt(p1, NOON)).toBe(2);
    expect(reminderStageAt(p1, shift(NOON, 60))).toBe(3);
    expect(reminderStageAt(p1, shift(NOON, 240))).toBe(4);
    expect(reminderStageAt({ ...p1, priority: "P3" }, shift(NOON, 240))).toBe(2);
    expect(reminderStageAt({ ...p1, kind: "personal" }, shift(NOON, 300))).toBe(3);
    expect(reminderStageAt(p1, shift(NOON, 600), false)).toBe(2);
  });
});

describe("deliverTaskDueReminders", () => {
  it("reminds the assignee before and at the due time, nudges, then tells the giver, each once", async () => {
    const task = await taskDue("admin", w.amit.id, "P1", NOON, "Collect KYC from Acme");

    expect(await deliverTaskDueReminders(w.ctx, shift(NOON, -90))).toBeGreaterThanOrEqual(1);
    expect((await bells(w.amit.id, task.id)).map((b) => b.title)).toContain("Due soon: Collect KYC from Acme");
    // Same step again: nothing new.
    const before = (await bells(w.amit.id, task.id)).length;
    await deliverTaskDueReminders(w.ctx, shift(NOON, -80));
    expect((await bells(w.amit.id, task.id)).length).toBe(before);

    await deliverTaskDueReminders(w.ctx, NOON);
    await deliverTaskDueReminders(w.ctx, shift(NOON, 61));
    const amit = (await bells(w.amit.id, task.id)).map((b) => b.title);
    expect(amit).toContain("Due now: Collect KYC from Acme");
    expect(amit.some((t) => t.startsWith("Overdue by 1 h"))).toBe(true);
    expect((await bells(w.admin.id, task.id)).some((b) => b.title.startsWith("Still not done"))).toBe(false);

    await deliverTaskDueReminders(w.ctx, shift(NOON, 241));
    expect((await bells(w.admin.id, task.id)).map((b) => b.title)).toContain("Still not done: Collect KYC from Acme");
    const lines = await w.ctx.db.select({ body: workTaskMessages.body }).from(workTaskMessages).where(eq(workTaskMessages.task_id, task.id));
    expect(lines.map((l) => l.body)).toEqual(expect.arrayContaining(["Due time reached.", expect.stringMatching(/^Automatic nudge/), expect.stringMatching(/^Escalated/)]));
  });

  it("sends only the furthest step for a task that is already late, and none for done tasks", async () => {
    const late = await taskDue("admin", w.neha.id, "P2", shift(NOON, -26 * 60), "Zenith re-quote");
    const done = await taskDue("admin", w.neha.id, "P1", shift(NOON, -5 * 60), "Already finished");
    await w.ctx.db.update(workTasks).set({ status: "done" }).where(eq(workTasks.id, done.id));

    await deliverTaskDueReminders(w.ctx, NOON);
    const neha = (await bells(w.neha.id, late.id)).map((b) => b.title).filter((t) => !t.startsWith("New task"));
    expect(neha).toHaveLength(1);
    expect(neha[0]).toMatch(/^Overdue by/);
    expect((await bells(w.admin.id, late.id)).map((b) => b.title)).toContain("Still not done: Zenith re-quote");
    expect((await bells(w.neha.id, done.id)).filter((b) => !b.title.startsWith("New task"))).toHaveLength(0);
  });

  it("waits for morning before chasing, and starts again when the due time moves", async () => {
    const task = await taskDue("admin", w.amit.id, "P1", shift(NIGHT, -180), "Night task");
    await deliverTaskDueReminders(w.ctx, NIGHT);
    let titles = (await bells(w.amit.id, task.id)).map((b) => b.title);
    expect(titles).toContain("Due now: Night task");
    expect(titles.some((t) => t.startsWith("Overdue"))).toBe(false);

    const later = shift(NIGHT, 24 * 60);
    await w.ctx.db.update(workTasks).set({ due_at: later.toISOString() }).where(eq(workTasks.id, task.id));
    await deliverTaskDueReminders(w.ctx, later);
    titles = (await bells(w.amit.id, task.id)).map((b) => b.title);
    expect(titles.filter((t) => t === "Due now: Night task")).toHaveLength(2);
  });

  it("never escalates a personal to-do", async () => {
    const todo = await taskDue("amit", w.amit.id, "P1", shift(NOON, -10 * 60), "My own to-do");
    await deliverTaskDueReminders(w.ctx, NOON);
    const [row] = await w.ctx.db.select({ stage: workTasks.reminder_stage }).from(workTasks).where(eq(workTasks.id, todo.id));
    expect(row?.stage).toBe(3);
  });
});
