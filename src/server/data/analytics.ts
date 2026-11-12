import "server-only";

import { and, asc, count, eq, gte, isNotNull, lt, ne, sql } from "drizzle-orm";

import { addDays, startOfBusinessDay, todayInBusinessTz } from "@/lib/dates";
import { CLOSED_STATUSES } from "@/lib/domain";

import { appSettings, leads, profiles } from "../db/schema";
import { assertAdmin, isAdmin, type Actor } from "./actor";
import type { DataContext } from "./context";

// Pipeline numbers for the analytics screen, over the leads the caller can
// see (an agent's numbers cover only their own leads), and the bulk-import
// round-robin.

export type AgentPipeline = {
  agent_id: string | null;
  agent_name: string;
  total: number;
  prospect: number;
  quoted: number;
  follow_up: number;
  won: number;
  lost: number;
  overdue_renewals: number;
  renewals_30d: number;
};

export type PipelineAnalytics = {
  today: string;
  total: number;
  duplicates: number;
  unassigned: number;
  by_status: Record<string, number>;
  by_product: Record<string, number>;
  by_type: Record<string, number>;
  by_business: Record<string, number>;
  renewals: { overdue: number; today: number; week: number; month: number; upcoming: number };
  renewals_by_month: { month: string; count: number }[];
  created_by_month: { month: string; count: number }[];
  agents: AgentPipeline[];
};

const STATUS_KEYS = {
  Prospect: "prospect",
  Quoted: "quoted",
  "Follow-up": "follow_up",
  "Closed Won": "won",
  "Closed Lost": "lost",
} as const;

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

// Everything is counted by D1 (GROUP BY), not by loading every lead into the
// Worker: Workers bill CPU per request, and reading 1,000+ rows to tally them
// in JavaScript cost far more than the 10 ms the Free plan allows.
export async function pipelineAnalytics(ctx: DataContext, actor: Actor, now: Date = new Date()): Promise<PipelineAnalytics> {
  const today = todayInBusinessTz(now);
  const month = today.slice(0, 7);
  const scope = isAdmin(actor) ? sql`1 = 1` : sql`${leads.assigned_agent_id} = ${actor.id}`;
  const open = sql`${leads.status} not in (${sql.join(
    CLOSED_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  )})`;
  const in7 = addDays(today, 7);
  const in30 = addDays(today, 30);
  const in90 = addDays(today, 90);
  const firstRenewalMonth = `${month}-01`;
  const afterRenewalMonths = `${shiftMonth(month, 12)}-01`;
  // created_at is a UTC ISO timestamp; +330 minutes gives the IST calendar month.
  const createdFrom = startOfBusinessDay(`${shiftMonth(month, -5)}-01`);
  const createdMonth = sql<string>`strftime('%Y-%m', ${leads.created_at}, '+330 minutes')`;
  const renewalMonth = sql<string>`substr(${leads.renewal_date}, 1, 7)`;
  const flag = (condition: ReturnType<typeof sql>) => sql<number>`coalesce(sum(case when ${condition} then 1 else 0 end), 0)`;

  const [byAgentStatus, byProduct, byType, byBusiness, renewalTotals, renewalMonths, createdMonths, team] = await ctx.db.batch([
    ctx.db
      .select({
        agent: leads.assigned_agent_id,
        status: leads.status,
        n: count(),
        duplicates: flag(sql`${leads.is_duplicate} = 1`).as("duplicates"),
        overdue: flag(sql`${open} and ${leads.renewal_date} < ${today}`).as("overdue"),
        due30: flag(sql`${open} and ${leads.renewal_date} >= ${today} and ${leads.renewal_date} <= ${in30}`).as("due30"),
      })
      .from(leads)
      .where(scope)
      .groupBy(leads.assigned_agent_id, leads.status),
    ctx.db.select({ key: leads.policy_product, n: count() }).from(leads).where(scope).groupBy(leads.policy_product),
    ctx.db.select({ key: leads.type, n: count() }).from(leads).where(scope).groupBy(leads.type),
    ctx.db.select({ key: leads.business_type, n: count() }).from(leads).where(scope).groupBy(leads.business_type),
    ctx.db
      .select({
        overdue: flag(sql`${leads.renewal_date} < ${today}`).as("overdue"),
        today: flag(sql`${leads.renewal_date} = ${today}`).as("due_today"),
        week: flag(sql`${leads.renewal_date} >= ${today} and ${leads.renewal_date} <= ${in7}`).as("due_week"),
        month: flag(sql`${leads.renewal_date} >= ${today} and ${leads.renewal_date} <= ${in30}`).as("due_month"),
        upcoming: flag(sql`${leads.renewal_date} >= ${today} and ${leads.renewal_date} <= ${in90}`).as("due_upcoming"),
      })
      .from(leads)
      .where(and(scope, open, isNotNull(leads.renewal_date))),
    ctx.db
      .select({ month: renewalMonth, n: count() })
      .from(leads)
      .where(and(scope, open, gte(leads.renewal_date, firstRenewalMonth), lt(leads.renewal_date, afterRenewalMonths)))
      .groupBy(renewalMonth),
    ctx.db
      .select({ month: createdMonth, n: count() })
      .from(leads)
      .where(and(scope, gte(leads.created_at, createdFrom)))
      .groupBy(createdMonth),
    ctx.db.select({ id: profiles.id, full_name: profiles.full_name }).from(profiles),
  ]);

  const names = new Map(team.map((p) => [p.id, p.full_name]));
  const tally = (rows: { key: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.key, r.n]));
  const byStatus: Record<string, number> = {};
  const agents = new Map<string, AgentPipeline>();
  let total = 0;
  let duplicates = 0;
  let unassigned = 0;
  for (const r of byAgentStatus) {
    total += r.n;
    duplicates += r.duplicates;
    if (r.agent === null) unassigned += r.n;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n;
    const key = r.agent ?? "";
    const agent =
      agents.get(key) ??
      ({
        agent_id: r.agent,
        agent_name: r.agent ? (names.get(r.agent) ?? "Unassigned") : "Unassigned",
        total: 0,
        prospect: 0,
        quoted: 0,
        follow_up: 0,
        won: 0,
        lost: 0,
        overdue_renewals: 0,
        renewals_30d: 0,
      } satisfies AgentPipeline);
    agent.total += r.n;
    // A status outside today's list (none since migration 0009) only counts in the total.
    const statusKey = STATUS_KEYS[r.status] as (typeof STATUS_KEYS)[keyof typeof STATUS_KEYS] | undefined;
    if (statusKey) agent[statusKey] += r.n;
    agent.overdue_renewals += r.overdue;
    agent.renewals_30d += r.due30;
    agents.set(key, agent);
  }
  const renewalCounts = new Map(renewalMonths.map((r) => [r.month, r.n]));
  const createdCounts = new Map(createdMonths.map((r) => [r.month, r.n]));
  const totals = renewalTotals[0];

  return {
    today,
    total,
    duplicates,
    unassigned,
    by_status: byStatus,
    by_product: tally(byProduct),
    by_type: tally(byType),
    by_business: tally(byBusiness),
    renewals: {
      overdue: totals?.overdue ?? 0,
      today: totals?.today ?? 0,
      week: totals?.week ?? 0,
      month: totals?.month ?? 0,
      upcoming: totals?.upcoming ?? 0,
    },
    renewals_by_month: Array.from({ length: 12 }, (_, i) => {
      const m = shiftMonth(month, i);
      return { month: m, count: renewalCounts.get(m) ?? 0 };
    }),
    created_by_month: Array.from({ length: 6 }, (_, i) => {
      const m = shiftMonth(month, i - 5);
      return { month: m, count: createdCounts.get(m) ?? 0 };
    }),
    agents: [...agents.values()].sort((a, b) => b.total - a.total || a.agent_name.localeCompare(b.agent_name)),
  };
}

/**
 * The next `n` active agents in name order, continuing where the last bulk
 * import stopped. Admins only.
 */
export async function nextRoundRobinAgents(ctx: DataContext, actor: Actor, n: number): Promise<string[]> {
  assertAdmin(actor);
  if (!Number.isInteger(n) || n < 1) return [];
  const agents = await ctx.db
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.role, "AGENT"), eq(profiles.is_active, true), isNotNull(profiles.id), ne(profiles.id, "")))
    .orderBy(asc(profiles.full_name), asc(profiles.id));
  if (agents.length === 0) return [];
  const cursor = await ctx.db.query.appSettings.findFirst({ where: eq(appSettings.key, "round_robin_cursor") });
  const start = (Number(cursor?.value) || 0) % agents.length;
  const picked = Array.from({ length: n }, (_, i) => agents[(start + i) % agents.length].id);
  const next = (start + n) % agents.length;
  await ctx.db
    .insert(appSettings)
    .values({ key: "round_robin_cursor", value: next, description: "Position of the next agent in bulk-import round-robin" })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: next } });
  return picked;
}

// --- Agent workload and renewal pipeline (admins) ----------------------------

export type AgentWorkload = {
  agent_id: string;
  agent_name: string;
  /** Leads not yet Closed Won or Closed Lost. */
  open_leads: number;
  /** Their tasks, meetings and renewal due dates not ticked off before today. */
  overdue_followups: number;
  /** Their leads (not Closed Lost) renewing today or in the next 7 days. */
  renewals_week: number;
};

/**
 * Per active team member: open leads, overdue follow-ups and renewals due
 * this week, side by side. Admins with nothing on their plate are left out.
 */
export async function agentWorkload(ctx: DataContext, actor: Actor, now: Date = new Date()): Promise<AgentWorkload[]> {
  assertAdmin(actor);
  const today = todayInBusinessTz(now);
  const todayStart = startOfBusinessDay(today);
  const in7 = addDays(today, 7);
  const rows = await ctx.db.all<AgentWorkload & { role: string }>(sql`
    select p.id as agent_id, p.full_name as agent_name, p.role,
      (select count(*) from ${leads} l where l.assigned_agent_id = p.id and l.status not in ('Closed Won', 'Closed Lost')) as open_leads,
      (select count(*) from events e where e.assigned_agent_id = p.id and e.is_completed = 0
        and e.is_background_reminder = 0 and e.event_timestamp < ${todayStart}) as overdue_followups,
      (select count(*) from ${leads} l where l.assigned_agent_id = p.id and l.status != 'Closed Lost'
        and l.renewal_date >= ${today} and l.renewal_date <= ${in7}) as renewals_week
    from ${profiles} p
    where p.is_active = 1
    order by p.full_name, p.id`);
  return rows
    .filter((r) => r.role === "AGENT" || r.open_leads + r.overdue_followups + r.renewals_week > 0)
    .map(({ role: _role, ...r }) => r);
}

export type RenewalWindow = "0-30" | "31-60" | "61-90";

export type RenewalReportRow = {
  id: number;
  client_name: string;
  agent_name: string;
  policy_product: string;
  sub_product_name: string;
  type: string;
  business_type: string;
  status: string;
  renewal_date: string;
  days_left: number;
  window: RenewalWindow;
  poc_name: string;
  poc_contact_number: string;
  poc_email_id: string;
};

/**
 * Leads (not Closed Lost) renewing in the next 90 days, with the 30-day window
 * each falls in, sorted by agent, product and date. Admins only.
 */
export async function renewalPipeline(ctx: DataContext, actor: Actor, now: Date = new Date()): Promise<{ today: string; rows: RenewalReportRow[] }> {
  assertAdmin(actor);
  const today = todayInBusinessTz(now);
  const rows = await ctx.db
    .select({
      id: leads.id,
      client_name: leads.client_name,
      agent_name: sql<string>`coalesce(${profiles.full_name}, 'Unassigned')`,
      policy_product: leads.policy_product,
      sub_product_name: leads.sub_product_name,
      type: leads.type,
      business_type: leads.business_type,
      status: leads.status,
      renewal_date: sql<string>`${leads.renewal_date}`,
      poc_name: leads.poc_name,
      poc_contact_number: leads.poc_contact_number,
      poc_email_id: leads.poc_email_id,
    })
    .from(leads)
    .leftJoin(profiles, eq(profiles.id, leads.assigned_agent_id))
    .where(
      and(
        ne(leads.status, "Closed Lost"),
        gte(leads.renewal_date, today),
        sql`${leads.renewal_date} <= ${addDays(today, 90)}`,
      ),
    )
    .orderBy(sql`${profiles.full_name} is null`, asc(profiles.full_name), asc(leads.policy_product), asc(leads.renewal_date), asc(leads.id));
  return {
    today,
    rows: rows.map((r) => {
      const days = Math.round((Date.parse(r.renewal_date) - Date.parse(today)) / 86_400_000);
      return { ...r, days_left: days, window: days <= 30 ? "0-30" : days <= 60 ? "31-60" : "61-90" };
    }),
  };
}
