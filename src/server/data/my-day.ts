import "server-only";

import { and, asc, count, desc, eq, gte, isNotNull, isNull, lt, lte, notInArray, type SQL } from "drizzle-orm";

import { addDays, startOfBusinessDay, todayInBusinessTz } from "@/lib/dates";
import { CLOSED_STATUSES } from "@/lib/domain";

import { events, leads } from "../db/schema";
import { isAdmin, type Actor } from "./actor";
import type { DataContext } from "./context";
import { countUnreadLeadNotes, unreadLeadNotes, type Lead, type LeadEvent, type UnreadNote } from "./leads";

// Everything the My Day screen shows, in one call. Lead numbers cover the
// caller's own leads (every lead, for admins); tasks are always the caller's own.

export type MyDay = {
  counts: { activeClients: number; quoted: number; followUps: number; overdueRenewals: number };
  /** Open leads renewing in the next 30 days, soonest first. */
  renewals: Lead[];
  /** Open leads whose renewal passed in the last 30 days, latest first. */
  overdueRenewals: Lead[];
  /** The caller's open tasks up to a week ahead (overdue ones included). */
  openTasks: LeadEvent[];
  doneToday: LeadEvent[];
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

  const countLeads = async (...conditions: (SQL | undefined)[]) => {
    const [row] = await ctx.db.select({ n: count() }).from(leads).where(and(scope, ...conditions));
    return row?.n ?? 0;
  };
  const myEvents = and(eq(events.assigned_agent_id, actor.id), eq(events.is_background_reminder, false));

  const [
    activeClients,
    quoted,
    followUps,
    overdueRenewalCount,
    renewals,
    overdueRenewals,
    openTasks,
    doneToday,
    recentlyAssigned,
    unassigned,
    unassignedCount,
    unreadNotes,
    unreadNoteCount,
  ] = await Promise.all([
    countLeads(eq(leads.status, "Active Client")),
    countLeads(eq(leads.status, "Quoted")),
    countLeads(eq(leads.status, "Follow-up")),
    // Every overdue renewal, like the list the KPI links to; the panel shows the last 30 days.
    countLeads(lt(leads.renewal_date, today), open),
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
      .select()
      .from(events)
      .where(and(myEvents, eq(events.is_completed, false), lt(events.event_timestamp, weekEndStart)))
      .orderBy(asc(events.event_timestamp))
      .limit(100),
    ctx.db
      .select()
      .from(events)
      .where(and(myEvents, eq(events.is_completed, true), gte(events.completed_at, todayStart)))
      .orderBy(desc(events.completed_at))
      .limit(20),
    ctx.db
      .select()
      .from(leads)
      .where(and(admin ? isNotNull(leads.assigned_agent_id) : scope, gte(leads.assigned_at, sevenDaysAgo)))
      .orderBy(desc(leads.assigned_at))
      .limit(8),
    admin
      ? ctx.db.select().from(leads).where(isNull(leads.assigned_agent_id)).orderBy(desc(leads.created_at)).limit(8)
      : null,
    admin ? ctx.db.select({ n: count() }).from(leads).where(isNull(leads.assigned_agent_id)) : null,
    unreadLeadNotes(ctx, actor, 8),
    countUnreadLeadNotes(ctx, actor),
  ]);

  return {
    counts: { activeClients, quoted, followUps, overdueRenewals: overdueRenewalCount },
    renewals,
    overdueRenewals,
    openTasks,
    doneToday,
    recentlyAssigned,
    unassigned: unassigned ? { leads: unassigned, count: unassignedCount?.[0]?.n ?? 0 } : null,
    unreadNotes,
    unreadNoteCount,
  };
}
