import "server-only";

import { and, asc, eq, isNull } from "drizzle-orm";

import { isIsoDate } from "@/lib/dates";
import { isTaskPriority, parseTags, type TaskPriority } from "@/lib/work-tasks";

import { businessHolidays, taskSlaRules } from "../db/schema";
import { assertAdmin, type Actor } from "./actor";
import type { DataContext } from "./context";
import { InvalidInputError } from "./errors";

// Admin > Task rules: per-tag reminder timings (SLAs) and the holiday calendar
// used by the due-time reminders in task-reminders.ts.

export type TaskRules = {
  rules: { id: number; tag: string; priority: TaskPriority | null; soon_minutes: number; nudge_minutes: number; escalate_minutes: number }[];
  holidays: { date: string; name: string }[];
};

export async function listTaskRules(ctx: DataContext, actor: Actor): Promise<TaskRules> {
  assertAdmin(actor);
  const [rules, holidays] = await Promise.all([
    ctx.db.select().from(taskSlaRules).orderBy(asc(taskSlaRules.tag), asc(taskSlaRules.priority)),
    ctx.db.select({ date: businessHolidays.date, name: businessHolidays.name }).from(businessHolidays).orderBy(asc(businessHolidays.date)),
  ]);
  return {
    rules: rules.map((r) => ({
      id: r.id,
      tag: r.tag,
      priority: r.priority,
      soon_minutes: r.soon_minutes,
      nudge_minutes: r.nudge_minutes,
      escalate_minutes: r.escalate_minutes,
    })),
    holidays,
  };
}

export type SlaRuleInput = { tag: string; priority?: string | null; soon_minutes: number; nudge_minutes: number; escalate_minutes: number };

function minutes(value: number, min: number, max: number, label: string): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < min || n > max) throw new InvalidInputError(`${label} must be between ${min} and ${max} minutes.`);
  return n;
}

/** Adds a rule, or replaces the one for the same tag and priority. */
export async function saveSlaRule(ctx: DataContext, actor: Actor, input: SlaRuleInput): Promise<void> {
  assertAdmin(actor);
  const tag = parseTags(input.tag)[0];
  if (!tag) throw new InvalidInputError("Give the rule a tag, like claim or kyc.");
  const priority = input.priority && isTaskPriority(input.priority) ? input.priority : null;
  const soon = minutes(input.soon_minutes, 0, 10080, "Due soon");
  const nudge = minutes(input.nudge_minutes, 5, 43200, "Nudge");
  const escalate = minutes(input.escalate_minutes, 5, 43200, "Escalate");
  if (escalate < nudge) throw new InvalidInputError("Escalate after the nudge, not before it.");
  const same = and(eq(taskSlaRules.tag, tag), priority ? eq(taskSlaRules.priority, priority) : isNull(taskSlaRules.priority));
  await ctx.db.batch([
    ctx.db.delete(taskSlaRules).where(same),
    ctx.db.insert(taskSlaRules).values({ tag, priority, soon_minutes: soon, nudge_minutes: nudge, escalate_minutes: escalate }),
  ]);
}

export async function deleteSlaRule(ctx: DataContext, actor: Actor, id: number): Promise<void> {
  assertAdmin(actor);
  await ctx.db.delete(taskSlaRules).where(eq(taskSlaRules.id, id));
}

export async function saveHoliday(ctx: DataContext, actor: Actor, date: string, name: string): Promise<void> {
  assertAdmin(actor);
  if (!isIsoDate(date)) throw new InvalidInputError("Pick a valid date.");
  const label = name.trim().slice(0, 80);
  if (!label) throw new InvalidInputError("Name the holiday.");
  await ctx.db.insert(businessHolidays).values({ date, name: label }).onConflictDoUpdate({ target: businessHolidays.date, set: { name: label } });
}

export async function deleteHoliday(ctx: DataContext, actor: Actor, date: string): Promise<void> {
  assertAdmin(actor);
  await ctx.db.delete(businessHolidays).where(eq(businessHolidays.date, date));
}
