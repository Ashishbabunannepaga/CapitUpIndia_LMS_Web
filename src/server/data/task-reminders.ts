import "server-only";

import { and, asc, eq, inArray, isNotNull, lt, lte, ne, or, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import type { TaskPriority } from "@/lib/work-tasks";

import { addDays, businessDateOf } from "@/lib/dates";

import { businessHolidays, notifications, profiles, taskSlaRules, workTaskMessages, workTasks, workTaskTags } from "../db/schema";
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
// A snoozed task (snoozed_until) gets nothing until the snooze ends.
// Admins can set other timings per tag (task_sla_rules, Admin > Task rules).
// Sundays and business_holidays pause nudges and escalations, and a day off
// between the due time and now does not count toward lateness.

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

export type Ladder = { soon: number; nudge: number; escalate: number };
export type SlaRule = { tag: string; priority: TaskPriority | null; soon_minutes: number; nudge_minutes: number; escalate_minutes: number };

/**
 * The timings for a task: a rule for one of its tags and its priority wins,
 * then a rule for one of its tags at any priority (the fastest nudge if
 * several match), then the default ladder.
 */
export function ladderFor(priority: TaskPriority, tags: readonly string[], rules: readonly SlaRule[]): Ladder {
  const toLadder = (r: SlaRule): Ladder => ({ soon: r.soon_minutes * MINUTE, nudge: r.nudge_minutes * MINUTE, escalate: r.escalate_minutes * MINUTE });
  const fastest = (list: SlaRule[]) => list.sort((a, b) => a.nudge_minutes - b.nudge_minutes)[0];
  const exact = fastest(rules.filter((r) => r.priority === priority && tags.includes(r.tag)));
  if (exact) return toLadder(exact);
  const anyPriority = fastest(rules.filter((r) => r.priority === null && tags.includes(r.tag)));
  return anyPriority ? toLadder(anyPriority) : REMINDER_LADDER[priority];
}

/** Sunday or a listed holiday (dates are YYYY-MM-DD in India). */
export function isDayOff(date: string, holidays: ReadonlySet<string>): boolean {
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 0 || holidays.has(date);
}

/** Whole days off from the due date to today (both included, India dates), as milliseconds. */
export function offTimeMs(dueAt: string, at: Date, holidays: ReadonlySet<string>): number {
  const today = businessDateOf(at);
  let day = businessDateOf(dueAt);
  let off = 0;
  for (let i = 0; i < 400 && day <= today; i += 1, day = addDays(day, 1)) {
    if (isDayOff(day, holidays)) off += 1;
  }
  return off * 24 * HOUR;
}

/** The highest step this task has reached at `at` (0 = nothing yet). */
export function reminderStageAt(
  task: { priority: TaskPriority; due_at: string; kind: "personal" | "assigned" },
  at: Date,
  working = inWorkingHours(at),
  ladder: Ladder = REMINDER_LADDER[task.priority],
  offMs = 0,
): number {
  const late = at.getTime() - Date.parse(task.due_at);
  const counted = late - offMs;
  let stage = 0;
  if (late >= -ladder.soon) stage = 1;
  if (late >= 0) stage = 2;
  if (working && counted >= ladder.nudge) stage = 3;
  if (working && task.kind === "assigned" && counted >= ladder.escalate) stage = 4;
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
  const [rules, holidayRows] = await Promise.all([
    ctx.db
      .select({
        tag: taskSlaRules.tag,
        priority: taskSlaRules.priority,
        soon_minutes: taskSlaRules.soon_minutes,
        nudge_minutes: taskSlaRules.nudge_minutes,
        escalate_minutes: taskSlaRules.escalate_minutes,
      })
      .from(taskSlaRules),
    ctx.db.select({ date: businessHolidays.date }).from(businessHolidays),
  ]);
  const holidays = new Set(holidayRows.map((h) => h.date));
  const lookahead = Math.max(LOOKAHEAD_MS, ...rules.map((r) => r.soon_minutes * MINUTE));
  const horizon = new Date(at.getTime() + lookahead).toISOString();
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
        // Snoozed by the assignee ("I'm on it"): wait until the snooze ends.
        or(isNull(workTasks.snoozed_until), lte(workTasks.snoozed_until, at.toISOString())),
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

  const working = inWorkingHours(at) && !isDayOff(businessDateOf(at), holidays);
  const tagsByTask = new Map<number, string[]>();
  if (rules.length > 0) {
    const ids = candidates.map((c) => c.id);
    for (let i = 0; i < ids.length; i += 90) {
      const rows = await ctx.db
        .select({ task_id: workTaskTags.task_id, tag: workTaskTags.tag })
        .from(workTaskTags)
        .where(inArray(workTaskTags.task_id, ids.slice(i, i + 90)));
      for (const row of rows) tagsByTask.set(row.task_id, [...(tagsByTask.get(row.task_id) ?? []), row.tag]);
    }
  }
  const people = await ctx.db
    .select({ id: profiles.id, full_name: profiles.full_name, is_active: profiles.is_active, role: profiles.role })
    .from(profiles);
  const admins = people.filter((p) => p.is_active && p.role === "ADMIN");
  const byId = new Map(people.map((p) => [p.id, p]));
  const stamp = at.toISOString();
  let sent = 0;

  for (const task of candidates) {
    const due = task.due_at!;
    const current = task.reminder_for === due ? task.reminder_stage : 0;
    const ladder = ladderFor(task.priority, tagsByTask.get(task.id) ?? [], rules);
    const offMs = offTimeMs(due, at, holidays);
    const target = reminderStageAt({ priority: task.priority, due_at: due, kind: task.kind }, at, working, ladder, offMs);
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
      // A task nobody gave (a renewal playbook step) escalates to the admins.
      const told = task.created_by ? (giver?.is_active ? [giver] : []) : admins;
      const names = task.created_by ? (giver?.full_name ?? "The person who gave it") : "The admins";
      for (const person of told) {
        if (person.id === task.assignee_id) continue;
        notify(person.id, `Still not done: ${task.title}`, `${assignee?.full_name ?? "The assignee"} is ${lateText(late)} past the due time (${meta}).`);
      }
      if (assigneeActive) notify(task.assignee_id, `Overdue by ${lateText(late)}: ${task.title}`, `${meta}. ${names} ${told.length === 1 ? "has" : "have"} been told.`);
      line(`Escalated: overdue by ${lateText(late)}, ${task.created_by ? (giver?.full_name ?? "the giver") : "admins"} notified.`);
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
