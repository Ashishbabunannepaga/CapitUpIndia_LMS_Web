import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import { notifications, workTaskMessages, workTasks } from "../../db/schema";
import { sendDayPlans } from "../day-plan";
import { AccessDeniedError, InvalidInputError } from "../errors";
import { deliverTaskDueReminders, ladderFor, offTimeMs, REMINDER_LADDER } from "../task-reminders";
import { deleteSlaRule, listTaskRules, saveHoliday, saveSlaRule } from "../task-rules";
import { createWorkTask, decideApproval } from "../work-tasks";
import { testWorld } from "./helpers";

let w: Awaited<ReturnType<typeof testWorld>>;

beforeAll(async () => {
  w = await testWorld();
});
afterAll(async () => {
  await w.dispose();
});

const bells = (userId: string, taskId: number) =>
  w.ctx.db
    .select({ title: notifications.title, body: notifications.body })
    .from(notifications)
    .where(and(eq(notifications.user_id, userId), eq(notifications.task_id, taskId)));

describe("approval requests", () => {
  it("lets an agent ask, only an admin decide, and needs a reason to reject", async () => {
    const ask = await createWorkTask(w.ctx, w.amit, { title: "5% discount for Acme", assignee_id: w.admin.id, approval: true });
    expect(ask.approval).toBe("pending");
    expect((await bells(w.admin.id, ask.id))[0]?.title).toBe("Approval needed from you: 5% discount for Acme");

    await expect(decideApproval(w.ctx, w.amit, ask.id, "approved")).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(decideApproval(w.ctx, w.admin, ask.id, "rejected", " ")).rejects.toBeInstanceOf(InvalidInputError);

    const done = await decideApproval(w.ctx, w.admin, ask.id, "approved", "Fine for this renewal only");
    expect(done).toMatchObject({ approval: "approved", status: "done", approval_by: w.admin.id });
    expect((await bells(w.amit.id, ask.id)).map((b) => b.title)).toContain("Approved by Asha Admin: 5% discount for Acme");
    const lines = await w.ctx.db.select({ body: workTaskMessages.body }).from(workTaskMessages).where(eq(workTaskMessages.task_id, ask.id));
    expect(lines.map((l) => l.body)).toContain("Asha Admin approved this: Fine for this renewal only");
    await expect(decideApproval(w.ctx, w.admin, ask.id, "rejected", "late")).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("ignores the approval flag when an admin gives a task", async () => {
    const task = await createWorkTask(w.ctx, w.admin, { title: "Not an approval", assignee_id: w.amit.id, approval: true });
    expect(task.approval).toBeNull();
  });
});

describe("task rules", () => {
  it("are admin only, replace the same tag and priority, and check the timings", async () => {
    await expect(saveSlaRule(w.ctx, w.amit, { tag: "claim", soon_minutes: 30, nudge_minutes: 30, escalate_minutes: 60 })).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await expect(saveSlaRule(w.ctx, w.admin, { tag: "claim", soon_minutes: 30, nudge_minutes: 60, escalate_minutes: 30 })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await saveSlaRule(w.ctx, w.admin, { tag: "Claim", soon_minutes: 30, nudge_minutes: 60, escalate_minutes: 120 });
    await saveSlaRule(w.ctx, w.admin, { tag: "claim", soon_minutes: 15, nudge_minutes: 30, escalate_minutes: 90 });
    await saveSlaRule(w.ctx, w.admin, { tag: "claim", priority: "P1", soon_minutes: 10, nudge_minutes: 10, escalate_minutes: 20 });
    const { rules } = await listTaskRules(w.ctx, w.admin);
    expect(rules.filter((r) => r.tag === "claim")).toHaveLength(2);
    expect(rules.find((r) => r.tag === "claim" && r.priority === null)?.nudge_minutes).toBe(30);
  });

  it("picks the tag rule for the priority, then any priority, then the default", () => {
    const rules = [
      { tag: "claim", priority: null, soon_minutes: 15, nudge_minutes: 30, escalate_minutes: 90 },
      { tag: "claim", priority: "P1" as const, soon_minutes: 10, nudge_minutes: 10, escalate_minutes: 20 },
    ];
    expect(ladderFor("P1", ["claim"], rules).nudge).toBe(10 * 60_000);
    expect(ladderFor("P2", ["claim", "gmc"], rules).nudge).toBe(30 * 60_000);
    expect(ladderFor("P2", ["gmc"], rules)).toEqual(REMINDER_LADDER.P2);
  });

  it("does not count Sundays and holidays as late, and pauses nudges on them", async () => {
    // Saturday 9 Mar 2030 noon IST, checked Monday 11 Mar noon IST: Sunday doesn't count.
    expect(offTimeMs("2030-03-09T06:30:00.000Z", new Date("2030-03-11T06:30:00.000Z"), new Set())).toBe(24 * 3600_000);
    expect(offTimeMs("2030-03-09T06:30:00.000Z", new Date("2030-03-11T06:30:00.000Z"), new Set(["2030-03-09"]))).toBe(48 * 3600_000);

    await saveHoliday(w.ctx, w.admin, "2030-03-13", "Holi");
    const task = await createWorkTask(w.ctx, w.admin, { title: "Holiday task", priority: "P1", assignee_id: w.neha.id });
    await w.ctx.db.update(workTasks).set({ due_at: "2030-03-13T04:30:00.000Z" }).where(eq(workTasks.id, task.id));
    await deliverTaskDueReminders(w.ctx, new Date("2030-03-13T08:30:00.000Z")); // 14:00 IST on Holi, 4 h late
    const titles = (await bells(w.neha.id, task.id)).map((b) => b.title);
    expect(titles).toContain("Due now: Holiday task");
    expect(titles.some((t) => t.startsWith("Overdue"))).toBe(false);
    await deleteSlaRule(w.ctx, w.admin, 999999);
  });
});

describe("morning plans", () => {
  it("sends each person a plan and admins a team check, once a day, with rules when AI fails", async () => {
    const task = await createWorkTask(w.ctx, w.admin, { title: "Call Zenith HR", priority: "P1", assignee_id: w.neha.id });
    await w.ctx.db.update(workTasks).set({ due_at: "2030-04-01T05:00:00.000Z" }).where(eq(workTasks.id, task.id));
    const at = new Date("2030-04-02T03:30:00.000Z");
    const writer = vi.fn(async (_p: { id: string }, kind: "plan" | "risk", _facts: string) => {
      void _facts;
      if (kind === "risk") throw new Error("AI down");
      return "- Call Zenith HR first";
    });

    const sent = await sendDayPlans(w.ctx, at, writer);
    expect(sent).toBeGreaterThan(0);
    const neha = await w.ctx.db.select().from(notifications).where(and(eq(notifications.user_id, w.neha.id), eq(notifications.title, "Your plan for today")));
    expect(neha[0]?.body).toBe("- Call Zenith HR first");
    const facts = writer.mock.calls.find((c) => c[0].id === w.neha.id)?.[2] ?? "";
    expect(facts).toContain('"Call Zenith HR" P1 todo');
    expect(facts).toContain("OVERDUE");

    const admin = await w.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.user_id, w.admin.id), eq(notifications.title, "Team check: who needs attention today")));
    expect(admin[0]?.body).toMatch(/Neha Agent: .*overdue tasks/);

    expect(await sendDayPlans(w.ctx, at, writer)).toBe(0);
  });
});
