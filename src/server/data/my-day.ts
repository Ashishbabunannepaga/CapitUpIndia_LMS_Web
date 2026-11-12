import "server-only";

import { and, asc, count, desc, eq, getTableColumns, gte, isNotNull, isNull, lt, lte, notInArray, sql, type SQL } from "drizzle-orm";

import { addDays, startOfBusinessDay, todayInBusinessTz } from "@/lib/dates";
import { ACTIVE_CLIENT_STATUS, CLOSED_STATUSES } from "@/lib/domain";

import { events, leads, profiles } from "../db/schema";
import { assertAdmin, isAdmin, type Actor } from "./actor";
import type { DataContext } from "./context";
import { InvalidInputError } from "./errors";
import { isStale } from "./stale";
import { countUnreadLeadNotesQuery, unreadLeadNotesQuery, type Lead, type LeadEvent, type UnreadNote } from "./leads";

// Everything the My Day screen shows, in one call. Lead numbers cover the
// caller's own leads (every lead, for admins); tasks are always the caller's own.

export type TaskWithLead = LeadEvent & { lead_name: string | null };

export type MyDay = {
  counts: { activeClients: number; quoted: number; followUps: number; overdueRenewals: number; stale: number };
  /** Open leads renewing in the next 30 days, soonest first. */
  renewals: Lead[];
  /** Open leads whose renewal passed in the last 30 days, latest first. */
  overdueRenewals: Lead[];
  /** The caller's open tasks up to a week ahead (overdue ones included), with the linked lead's name. */
  openTasks: TaskWithLead[];
  doneToday: TaskWithLead[];
  /** Leads assigned in the last 7 days: to the caller, or to anyone for admins. */
  recentlyAssigned: Lead[];
  /** Admins only: the newest unassigned leads, and how many there are. */
  unassigned: { leads: Lead[]; count: number } | null;
  unreadNotes: UnreadNote[];
  unreadNoteCount: number;
};

export async function myDay(ctx: DataContext, actor: Actor, now: Date = new Date()): Promise<MyDay> {
  const admin = isAdmin(actor);
  const scope = admin ? undefined : eq(leads.assigned_agent_id, actor.id);
  const open = notInArray(leads.status, [...CLOSED_STATUSES]);
  const today = todayInBusinessTz(now);
  const todayStart = startOfBusinessDay(today);
  const weekEndStart = startOfBusinessDay(addDays(today, 8));
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();

  const countLeads = (...conditions: (SQL | undefined)[]) =>
    ctx.db.select({ n: count().as("n") }).from(leads).where(and(scope, ...conditions));
  const withLeadName = { ...getTableColumns(events), lead_name: leads.client_name };
  const myEvents = and(eq(events.assigned_agent_id, actor.id), eq(events.is_background_reminder, false));
  // The unassigned queue is for admins; for an agent the query matches nothing.
  const unassignedWhere = and(isNull(leads.assigned_agent_id), admin ? undefined : sql`0`);

  // One batch, so the whole screen costs a single D1 round trip.
  const [
    activeClients,
    quoted,
    followUps,
    overdueRenewalCount,
    staleCount,
    renewals,
    overdueRenewals,
    openTasks,
    doneToday,
    recentlyAssigned,
    unassigned,
    unassignedCount,
    unreadNotes,
    unreadNoteCount,
  ] = await ctx.db.batch([
    // Closed Won leads are the active clients.
    countLeads(eq(leads.status, ACTIVE_CLIENT_STATUS)),
    countLeads(eq(leads.status, "Quoted")),
    countLeads(eq(leads.status, "Follow-up")),
    // Every overdue renewal, like the list the KPI links to; the panel shows the last 30 days.
    countLeads(lt(leads.renewal_date, today), open),
    // Open leads nobody has touched for the admins' stale threshold.
    countLeads(isStale),
    ctx.db
      .select()
      .from(leads)
      .where(and(scope, gte(leads.renewal_date, today), lte(leads.renewal_date, addDays(today, 30)), open))
      .orderBy(asc(leads.renewal_date), asc(leads.id))
      .limit(60),
    ctx.db
      .select()
      .from(leads)
      .where(and(scope, lt(leads.renewal_date, today), gte(leads.renewal_date, addDays(today, -30)), open))
      .orderBy(desc(leads.renewal_date), asc(leads.id))
      .limit(10),
    ctx.db
      .select(withLeadName)
      .from(events)
      .leftJoin(leads, eq(leads.id, events.lead_id))
      .where(and(myEvents, eq(events.is_completed, false), lt(events.event_timestamp, weekEndStart)))
      .orderBy(asc(events.event_timestamp))
      .limit(100),
    ctx.db
      .select(withLeadName)
      .from(events)
      .leftJoin(leads, eq(leads.id, events.lead_id))
      .where(and(myEvents, eq(events.is_completed, true), gte(events.completed_at, todayStart)))
      .orderBy(desc(events.completed_at))
      .limit(20),
    ctx.db
      .select()
      .from(leads)
      .where(and(admin ? isNotNull(leads.assigned_agent_id) : scope, gte(leads.assigned_at, sevenDaysAgo)))
      .orderBy(desc(leads.assigned_at))
      .limit(8),
    ctx.db.select().from(leads).where(unassignedWhere).orderBy(desc(leads.created_at)).limit(8),
    ctx.db.select({ n: count().as("n") }).from(leads).where(unassignedWhere),
    unreadLeadNotesQuery(ctx, actor, 8),
    countUnreadLeadNotesQuery(ctx, actor),
  ]);

  return {
    counts: {
      activeClients: activeClients[0]?.n ?? 0,
      quoted: quoted[0]?.n ?? 0,
      followUps: followUps[0]?.n ?? 0,
      overdueRenewals: overdueRenewalCount[0]?.n ?? 0,
      stale: staleCount[0]?.n ?? 0,
    },
    renewals,
    overdueRenewals,
    openTasks,
    doneToday,
    recentlyAssigned,
    unassigned: admin ? { leads: unassigned, count: unassignedCount[0]?.n ?? 0 } : null,
    unreadNotes,
    unreadNoteCount: unreadNoteCount[0]?.n ?? 0,
  };
}

/**
 * The agent whose My Day an admin wants to look at ("View as agent"): their
 * profile, to pass as the actor to read-only screens (myDay,
 * pipelineAnalytics). Admins only, and only agents: no session changes hands
 * and nothing is written as the agent.
 */
export async function agentForView(ctx: DataContext, actor: Actor, agentId: string): Promise<Actor> {
  assertAdmin(actor);
  const agent = await ctx.db.query.profiles.findFirst({ where: eq(profiles.id, agentId) });
  if (!agent || agent.role !== "AGENT") throw new InvalidInputError("That agent no longer exists.");
  return agent;
}
