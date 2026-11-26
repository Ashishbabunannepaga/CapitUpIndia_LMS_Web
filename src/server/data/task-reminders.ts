import "server-only";

import { and, asc, eq, inArray, isNotNull, lt, lte, ne, or, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import type { TaskPriority } from "@/lib/work-tasks";

import { notifications, profiles, workTaskMessages, workTasks } from "../db/schema";
import type { DataContext } from "./context";

// Due-time reminders for Task Grid, run by the per-minute Cron Trigger.
//
// Every open task with a due time climbs one ladder, faster for P1:
//   1 due soon   (assignee)            P1 2 h before, P2 1 h, P3 30 min
//   2 due now    (assignee)            at the due time
//   3 auto-nudge (assignee)            P1 1 h late, P2 3 h, P3 24 h
//   4 escalation (the person who gave it)  P1 4 h late, P2 24 h, P3 48 h
// A task that is already further along (created late, or the job was down)
// gets only the highest step it has reached, never a burst. Steps 3 and 4
// wait for working hours (09:00-21:00 IST) so nobody is chased at night;
// "due soon" and "due now" always go, since the person chose that time.
// Personal to-dos stop at step 3. Blocked and done tasks are left alone.
// Changing the due time starts the ladder again (reminder_for tracks it).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const REMINDER_LADDER: Record<TaskPriority, { soon: number; nudge: number; escalate: number }> = {
  P1: { soon: 2 * HOUR, nudge: 1 * HOUR, escalate: 4 * HOUR },
  P2: { soon: 1 * HOUR, nudge: 3 * HOUR, escalate: 24 * HOUR },
  P3: { soon: 30 * MINUTE, nudge: 24 * HOUR, escalate: 48 * HOUR },
};

/** The furthest any ladder looks ahead of the due time. */
const LOOKAHEAD_MS = 2 * HOUR;
const BATCH = 200;

/** 09:00-21:00 in India: when overdue nudges and escalations may go out. */
export function inWorkingHours(at: Date): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Asia/Kolkata" }).format(at));
  return hour >= 9 && hour < 21;
}

/** The highest step this task has reached at `at` (0 = nothing yet). */
export function reminderStageAt(
  task: { priority: TaskPriority; due_at: string; kind: "personal" | "assigned" },
  at: Date,
  working = inWorkingHours(at),
): number {
  const ladder = REMINDER_LADDER[task.priority];
  const late = at.getTime() - Date.parse(task.due_at);
  let stage = 0;
  if (late >= -ladder.soon) stage = 1;
  if (late >= 0) stage = 2;
  if (working && late >= ladder.nudge) stage = 3;
  if (working && task.kind === "assigned" && late >= ladder.escalate) stage = 4;
  return stage;
}

function lateText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

function clock(dueAt: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(
    new Date(dueAt),
  );
}

/** Sends every reminder step that is due. Returns how many bell notifications went out. */
export async function deliverTaskDueReminders(ctx: DataContext, at: Date = new Date(), limit = BATCH): Promise<number> {
  const horizon = new Date(at.getTime() + LOOKAHEAD_MS).toISOString();
  const candidates = await ctx.db
    .select({
      id: workTasks.id,
      kind: workTasks.kind,
      title: workTasks.title,
      priority: workTasks.priority,
      due_at: workTasks.due_at,
      assignee_id: workTasks.assignee_id,
      created_by: workTasks.created_by,
      lead_id: workTasks.lead_id,
      reminder_stage: workTasks.reminder_stage,
      reminder_for: workTasks.reminder_for,
    })
    .from(workTasks)
    .where(
      and(
        inArray(workTasks.status, ["todo", "in_progress"]),
        isNotNull(workTasks.due_at),
        lte(workTasks.due_at, horizon),
        // Not finished with this due time yet.
        // (personal to-dos stop at the nudge, so they leave the queue there).
        or(
          isNull(workTasks.reminder_for),
          ne(workTasks.reminder_for, workTasks.due_at),
          lt(workTasks.reminder_stage, sql`case when ${workTasks.kind} = 'personal' then 3 else 4 end`),
        ),
      ),
    )
    .orderBy(asc(workTasks.due_at))
    .limit(Math.max(limit, 1));
  if (candidates.length === 0) return 0;

  const working = inWorkingHours(at);
  const people = await ctx.db.select({ id: profiles.id, full_name: profiles.full_name, is_active: profiles.is_active }).from(profiles);
  const byId = new Map(people.map((p) => [p.id, p]));
  const stamp = at.toISOString();
  let sent = 0;

  for (const task of candidates) {
    const due = task.due_at!;
    const current = task.reminder_for === due ? task.reminder_stage : 0;
    const target = reminderStageAt({ priority: task.priority, due_at: due, kind: task.kind }, at, working);
    if (target <= current) continue;

    const assignee = byId.get(task.assignee_id);
    const giver = task.created_by ? byId.get(task.created_by) : undefined;
    const late = at.getTime() - Date.parse(due);
    const meta = `${task.priority} · due ${clock(due)}`;
    const writes: BatchItem<"sqlite">[] = [];
    let bells = 0;
    const notify = (userId: string, title: string, body: string) => {
      writes.push(
        ctx.db.insert(notifications).values({
          user_id: userId,
          kind: "other",
          title: title.slice(0, 300),
          body: body.slice(0, 2000),
          task_id: task.id,
          lead_id: task.lead_id,
        }),
      );
      bells += 1;
    };
    const line = (body: string) =>
      writes.push(ctx.db.insert(workTaskMessages).values({ task_id: task.id, author_id: null, author_name: "Reminder", kind: "system", body }));

    const assigneeActive = !!assignee?.is_active;
    if (target === 1) {
      if (assigneeActive) notify(task.assignee_id, `Due soon: ${task.title}`, `${meta}. Due in ${lateText(-late)}.`);
    } else if (target === 2) {
      if (assigneeActive) notify(task.assignee_id, `Due now: ${task.title}`, meta);
      line("Due time reached.");
    } else if (target === 3) {
      if (assigneeActive) notify(task.assignee_id, `Overdue by ${lateText(late)}: ${task.title}`, `${meta}. Update the status or post what's holding it up.`);
      line(`Automatic nudge: overdue by ${lateText(late)}.`);
    } else {
      if (giver?.is_active && giver.id !== task.assignee_id) {
        notify(giver.id, `Still not done: ${task.title}`, `${assignee?.full_name ?? "The assignee"} is ${lateText(late)} past the due time (${meta}).`);
      }
      if (assigneeActive) notify(task.assignee_id, `Overdue by ${lateText(late)}: ${task.title}`, `${meta}. ${giver?.full_name ?? "The person who gave it"} has been told.`);
      line(`Escalated: overdue by ${lateText(late)}, ${giver?.full_name ?? "the giver"} notified.`);
    }

    // Claim the step first so two overlapping runs never send it twice.
    const claimed = await ctx.db
      .update(workTasks)
      .set({ reminder_stage: target, reminder_for: due, ...(target >= 2 ? { last_activity_at: stamp } : {}) })
      .where(
        and(
          eq(workTasks.id, task.id),
          eq(workTasks.due_at, due),
          sql`(case when ${workTasks.reminder_for} = ${due} then ${workTasks.reminder_stage} else 0 end) = ${current}`,
        ),
      )
      .returning({ id: workTasks.id });
    if (claimed.length === 0 || writes.length === 0) continue;
    await ctx.db.batch(writes as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    sent += bells;
  }
  return sent;
}
