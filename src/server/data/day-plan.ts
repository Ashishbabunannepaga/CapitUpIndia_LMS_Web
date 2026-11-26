import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";

import { addDays, todayInBusinessTz } from "@/lib/dates";

import { appSettings, notifications, profiles, workTasks } from "../db/schema";
import { isAdmin, type Actor } from "./actor";
import type { DataContext } from "./context";
import { myDay } from "./my-day";

// The 09:00 IST morning push: every active member gets "your plan for today"
// (their open Task Grid tasks, renewals and stale leads, put in order by AI),
// and admins also get "who's slipping" across the team. Without AI, or if a
// call fails, a plain rule-based list goes out instead. Sent once per day.

export const DAY_PLAN_SETTING = "day_plan_sent_on";

/** Writes the text with AI: (person, prompt kind, facts) -> plan. Throw to fall back to rules. */
export type PlanWriter = (person: Pick<Actor, "id" | "full_name">, kind: "plan" | "risk", facts: string, admin: boolean) => Promise<string>;

type Person = Actor;

const short = (iso: string) =>
  new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(iso));

async function openTasksFor(ctx: DataContext, userId: string) {
  return ctx.db
    .select({ title: workTasks.title, priority: workTasks.priority, status: workTasks.status, due_at: workTasks.due_at, by: workTasks.created_by_name, kind: workTasks.kind })
    .from(workTasks)
    .where(and(eq(workTasks.assignee_id, userId), inArray(workTasks.status, ["todo", "in_progress", "blocked"])))
    .orderBy(asc(workTasks.priority), asc(workTasks.due_at))
    .limit(40);
}

/** The facts for one person's plan, and the rule-based plan used without AI. */
export async function planFacts(ctx: DataContext, person: Person, at: Date): Promise<{ facts: string; fallback: string; empty: boolean }> {
  const today = todayInBusinessTz(at);
  const weekEnd = addDays(today, 7);
  const [tasks, day] = await Promise.all([openTasksFor(ctx, person.id), myDay(ctx, person, at)]);
  const now = at.toISOString();
  const overdue = tasks.filter((t) => t.due_at && t.due_at < now);
  const lines = tasks.slice(0, 12).map((t) => {
    const late = t.due_at && t.due_at < now ? " OVERDUE" : "";
    return `- Task "${t.title}" ${t.priority} ${t.status}${t.due_at ? `, due ${short(t.due_at)}${late}` : ""}${t.kind === "assigned" && t.by ? `, from ${t.by}` : ""}`;
  });
  const renewals = day.renewals.filter((l) => l.renewal_date && l.renewal_date <= weekEnd).slice(0, 6);
  const facts = [
    `Person: ${person.full_name}`,
    `Open tasks: ${tasks.length} (${overdue.length} overdue)`,
    ...lines,
    `Renewals in the next 7 days: ${renewals.length}`,
    ...renewals.map((l) => `- Renewal "${l.client_name}" on ${l.renewal_date}`),
    `Overdue renewals: ${day.counts.overdueRenewals}`,
    ...day.overdueRenewals.slice(0, 3).map((l) => `- Overdue renewal "${l.client_name}" (was ${l.renewal_date})`),
    `Stale leads (no activity for a while): ${day.counts.stale}`,
    `Closed deals waiting for the policy upload: ${day.awaitingPolicy.length}`,
  ].join("\n");

  const fallback = [
    ...overdue.slice(0, 3).map((t) => `- Overdue: ${t.title}`),
    ...tasks.filter((t) => !overdue.includes(t)).slice(0, 2).map((t) => `- ${t.priority}: ${t.title}${t.due_at ? ` (due ${short(t.due_at)})` : ""}`),
    ...renewals.slice(0, 2).map((l) => `- Renewal: ${l.client_name} on ${l.renewal_date}`),
    day.counts.overdueRenewals ? `- ${day.counts.overdueRenewals} overdue renewal(s) to chase` : "",
    day.counts.stale ? `- ${day.counts.stale} stale lead(s) to revive` : "",
  ]
    .filter(Boolean)
    .slice(0, 6)
    .join("\n");
  const empty = tasks.length === 0 && renewals.length === 0 && day.counts.overdueRenewals === 0 && day.counts.stale === 0;
  return { facts, fallback: fallback || "- Nothing urgent. A good day to revive old leads.", empty };
}

/** Per-agent risk facts for the admin report, and the rule-based version. */
export async function teamRiskFacts(ctx: DataContext, agents: readonly Person[], at: Date): Promise<{ facts: string; fallback: string }> {
  const now = at.toISOString();
  const rows = await Promise.all(
    agents.map(async (agent) => {
      const [tasks, day] = await Promise.all([openTasksFor(ctx, agent.id), myDay(ctx, agent, at)]);
      const overdue = tasks.filter((t) => t.due_at && t.due_at < now).length;
      const blocked = tasks.filter((t) => t.status === "blocked").length;
      const score = overdue * 3 + blocked * 2 + day.counts.overdueRenewals * 2 + day.counts.stale;
      return { name: agent.full_name, open: tasks.length, overdue, blocked, overdueRenewals: day.counts.overdueRenewals, stale: day.counts.stale, score };
    }),
  );
  rows.sort((a, b) => b.score - a.score);
  const facts = rows
    .map((r) => `- ${r.name}: ${r.open} open tasks, ${r.overdue} overdue, ${r.blocked} blocked, ${r.overdueRenewals} overdue renewals, ${r.stale} stale leads`)
    .join("\n");
  const slipping = rows.filter((r) => r.score > 0);
  const fallback = slipping.length
    ? slipping
        .slice(0, 6)
        .map((r) => `- ${r.name}: ${[r.overdue && `${r.overdue} overdue tasks`, r.blocked && `${r.blocked} blocked`, r.overdueRenewals && `${r.overdueRenewals} overdue renewals`, r.stale && `${r.stale} stale leads`].filter(Boolean).join(", ")}`)
        .join("\n")
    : "- Nobody is slipping. Everything is on time.";
  return { facts: facts || "(no agents)", fallback };
}

async function write(writer: PlanWriter | undefined, person: Person, kind: "plan" | "risk", facts: string, fallback: string): Promise<string> {
  if (!writer) return fallback;
  try {
    const text = (await writer(person, kind, facts, isAdmin(person))).trim();
    return text ? text.slice(0, 1900) : fallback;
  } catch {
    return fallback;
  }
}

/** Sends the morning plans (and admin risk reports) once per India date. Returns how many went out. */
export async function sendDayPlans(ctx: DataContext, at: Date = new Date(), writer?: PlanWriter): Promise<number> {
  const today = todayInBusinessTz(at);
  // Claim today first so a retried or overlapping run never sends twice.
  const prior = await ctx.db.query.appSettings.findFirst({ where: eq(appSettings.key, DAY_PLAN_SETTING) });
  if (prior?.value === today) return 0;
  await ctx.db
    .insert(appSettings)
    .values({ key: DAY_PLAN_SETTING, value: today, description: "India date the 09:00 day plans last went out." })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: today } });

  const people = await ctx.db.select().from(profiles).where(eq(profiles.is_active, true));
  const agents = people.filter((p) => !isAdmin(p));
  let risk: Awaited<ReturnType<typeof teamRiskFacts>> | null = null;
  let sent = 0;
  for (const person of people) {
    const plan = await planFacts(ctx, person, at);
    const rows: (typeof notifications.$inferInsert)[] = [];
    if (!plan.empty) {
      rows.push({ user_id: person.id, kind: "other", title: "Your plan for today", body: await write(writer, person, "plan", plan.facts, plan.fallback) });
    }
    if (isAdmin(person) && agents.length) {
      risk ??= await teamRiskFacts(ctx, agents, at);
      rows.push({ user_id: person.id, kind: "other", title: "Team check: who needs attention today", body: await write(writer, person, "risk", risk.facts, risk.fallback) });
    }
    if (rows.length) {
      await ctx.db.insert(notifications).values(rows);
      sent += rows.length;
    }
  }
  return sent;
}
