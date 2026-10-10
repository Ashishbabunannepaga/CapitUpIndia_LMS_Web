import "server-only";

import { and, asc, eq, isNotNull, ne } from "drizzle-orm";

import { addDays, businessDateOf, todayInBusinessTz } from "@/lib/dates";
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
  active_client: number;
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
  "Active Client": "active_client",
  "Follow-up": "follow_up",
  "Closed Won": "won",
  "Closed Lost": "lost",
} as const;

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

export async function pipelineAnalytics(ctx: DataContext, actor: Actor, now: Date = new Date()): Promise<PipelineAnalytics> {
  const [rows, team] = await Promise.all([
    ctx.db
      .select({
        status: leads.status,
        policy_product: leads.policy_product,
        type: leads.type,
        business_type: leads.business_type,
        assigned_agent_id: leads.assigned_agent_id,
        renewal_date: leads.renewal_date,
        created_at: leads.created_at,
        is_duplicate: leads.is_duplicate,
      })
      .from(leads)
      .where(isAdmin(actor) ? undefined : eq(leads.assigned_agent_id, actor.id)),
    ctx.db.select({ id: profiles.id, full_name: profiles.full_name }).from(profiles),
  ]);
  const names = new Map(team.map((p) => [p.id, p.full_name]));
  const today = todayInBusinessTz(now);
  const month = today.slice(0, 7);
  const tally = (key: (r: (typeof rows)[number]) => string) =>
    rows.reduce<Record<string, number>>((acc, r) => ((acc[key(r)] = (acc[key(r)] ?? 0) + 1), acc), {});

  const open = rows.filter((r) => !CLOSED_STATUSES.includes(r.status));
  const dated = open.filter((r) => r.renewal_date !== null) as ((typeof rows)[number] & { renewal_date: string })[];
  const within = (days: number) => dated.filter((r) => r.renewal_date >= today && r.renewal_date <= addDays(today, days)).length;

  const agents = new Map<string, AgentPipeline>();
  for (const r of rows) {
    const key = r.assigned_agent_id ?? "";
    const agent =
      agents.get(key) ??
      ({
        agent_id: r.assigned_agent_id,
        agent_name: r.assigned_agent_id ? (names.get(r.assigned_agent_id) ?? "Unassigned") : "Unassigned",
        total: 0,
        prospect: 0,
        quoted: 0,
        active_client: 0,
        follow_up: 0,
        won: 0,
        lost: 0,
        overdue_renewals: 0,
        renewals_30d: 0,
      } satisfies AgentPipeline);
    agent.total += 1;
    agent[STATUS_KEYS[r.status]] += 1;
    if (!CLOSED_STATUSES.includes(r.status) && r.renewal_date) {
      if (r.renewal_date < today) agent.overdue_renewals += 1;
      else if (r.renewal_date <= addDays(today, 30)) agent.renewals_30d += 1;
    }
    agents.set(key, agent);
  }

  return {
    today,
    total: rows.length,
    duplicates: rows.filter((r) => r.is_duplicate).length,
    unassigned: rows.filter((r) => r.assigned_agent_id === null).length,
    by_status: tally((r) => r.status),
    by_product: tally((r) => r.policy_product),
    by_type: tally((r) => r.type),
    by_business: tally((r) => r.business_type),
    renewals: {
      overdue: dated.filter((r) => r.renewal_date < today).length,
      today: dated.filter((r) => r.renewal_date === today).length,
      week: within(7),
      month: within(30),
      upcoming: within(90),
    },
    renewals_by_month: Array.from({ length: 12 }, (_, i) => {
      const m = shiftMonth(month, i);
      return { month: m, count: open.filter((r) => r.renewal_date?.startsWith(m)).length };
    }),
    created_by_month: Array.from({ length: 6 }, (_, i) => {
      const m = shiftMonth(month, i - 5);
      return { month: m, count: rows.filter((r) => businessDateOf(r.created_at).startsWith(m)).length };
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
