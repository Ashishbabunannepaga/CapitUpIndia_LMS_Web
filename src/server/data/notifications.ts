import "server-only";

import { and, asc, count, desc, eq, getTableColumns, gt, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import { businessHhmm, parseHhmm, to12Hour } from "@/lib/clock";
import { formatDate, formatDateTime } from "@/lib/dates";
import { CLOSED_STATUSES } from "@/lib/domain";

import { events, leads, notifications, profiles } from "../db/schema";
import type { Actor } from "./actor";
import type { DataContext } from "./context";
import { lastActivityAt } from "./stale";

// The reminder bell. Reminders are created by the per-minute cron
// (deliverDueReminders for renewals and their escalations, deliverTaskReminders
// for tasks and meetings); people can only read and dismiss their own.

export type Notification = typeof notifications.$inferSelect;

export async function recentNotifications(ctx: DataContext, actor: Actor, limit = 20) {
  const [items, [unread]] = await ctx.db.batch(recentNotificationsQueries(ctx, actor, limit));
  return { items, unread: unread?.n ?? 0 };
}

/** The two queries behind recentNotifications, for callers that batch them with others. */
export function recentNotificationsQueries(ctx: DataContext, actor: Actor, limit = 20) {
  return [
    ctx.db
      .select()
      .from(notifications)
      .where(eq(notifications.user_id, actor.id))
      .orderBy(desc(notifications.created_at), desc(notifications.id))
      .limit(limit),
    ctx.db
      .select({ n: count().as("n") })
      .from(notifications)
      .where(and(eq(notifications.user_id, actor.id), isNull(notifications.read_at))),
  ] as const;
}

/** Marks one of the caller's notifications, or all of them, as read. */
export async function markNotificationsRead(ctx: DataContext, actor: Actor, id?: number): Promise<void> {
  await ctx.db
    .update(notifications)
    .set({ read_at: new Date().toISOString() })
    .where(
      and(
        eq(notifications.user_id, actor.id),
        isNull(notifications.read_at),
        id !== undefined ? eq(notifications.id, id) : undefined,
      ),
    );
}

/**
 * Due reminders handled per cron run. The cron runs every minute, so a
 * backlog (say after an import) drains over a few minutes instead of one run
 * blowing the Worker's CPU limit and sending nothing.
 */
export const REMINDER_BATCH = 100;

/** Renewal milestones that also alert the admins when the agent has gone quiet. */
export const ESCALATE_MILESTONES = ["T-10 Days", "T-3 Days"] as const;
/** Days without any activity on the lead before a T-10 or T-3 reminder is escalated. */
export const ESCALATE_AFTER_DAYS = 3;

/**
 * Sends due renewal reminders. Marks every due background reminder as sent;
 * for each open lead, the latest due milestone becomes one notification for
 * its agent, or for every active admin when the lead has no active agent.
 * Safe to run again: a reminder is sent once. Returns notifications created.
 */
export async function deliverDueReminders(ctx: DataContext, at: Date = new Date(), limit = REMINDER_BATCH): Promise<number> {
  const stamp = at.toISOString();
  const due = await ctx.db
    .select({
      id: events.id,
      lead_id: events.lead_id,
      milestone: events.milestone,
      event_timestamp: events.event_timestamp,
      assigned_agent_id: events.assigned_agent_id,
    })
    .from(events)
    .where(and(eq(events.is_background_reminder, true), isNull(events.reminder_sent_at), lte(events.event_timestamp, stamp)))
    .orderBy(asc(events.event_timestamp))
    .limit(Math.max(limit, 1));
  if (due.length === 0) return 0;

  // Latest due milestone per lead.
  const latest = new Map<number, (typeof due)[number]>();
  for (const event of due) {
    if (event.lead_id === null) continue;
    const seen = latest.get(event.lead_id);
    if (!seen || seen.event_timestamp <= event.event_timestamp) latest.set(event.lead_id, event);
  }

  // T-10 and T-3 milestones that fell due in this run, per lead (for escalation).
  const escalating = new Map<number, (typeof due)[number]>();
  for (const event of due) {
    if (event.lead_id !== null && event.milestone && (ESCALATE_MILESTONES as readonly string[]).includes(event.milestone)) {
      escalating.set(event.lead_id, event);
    }
  }

  const leadIds = [...latest.keys()];
  const [leadRows, team] = await Promise.all([
    leadIds.length
      ? ctx.db
          .select({ ...getTableColumns(leads), last_activity_at: lastActivityAt })
          .from(leads)
          .where(inArray(leads.id, leadIds))
      : Promise.resolve([] as (typeof leads.$inferSelect & { last_activity_at: string })[]),
    ctx.db.select({ id: profiles.id, role: profiles.role, is_active: profiles.is_active, full_name: profiles.full_name }).from(profiles),
  ]);
  const active = new Map(team.filter((p) => p.is_active).map((p) => [p.id, p]));
  const admins = [...active.values()].filter((p) => p.role === "ADMIN").map((p) => p.id);
  const quietSince = new Date(at.getTime() - ESCALATE_AFTER_DAYS * 86_400_000).toISOString();

  const rows: (typeof notifications.$inferInsert)[] = [];
  for (const lead of leadRows) {
    if (CLOSED_STATUSES.includes(lead.status) || !lead.renewal_date) continue;
    const event = latest.get(lead.id)!;
    const agent = event.assigned_agent_id;
    const recipients = agent && active.has(agent) ? [agent] : admins;
    const contact = [lead.poc_name.trim(), lead.poc_contact_number.trim() ? `(${lead.poc_contact_number.trim()})` : ""]
      .filter(Boolean)
      .join(" ");
    const body =
      `Renews ${formatDate(lead.renewal_date)}` +
      (contact ? `. Contact: ${contact}` : "") +
      (agent === null ? ". This lead is unassigned." : "");
    for (const user_id of recipients) {
      rows.push({
        user_id,
        kind: "renewal_reminder",
        title: `${event.milestone}: ${lead.client_name} renewal${lead.policy_product !== "Not Specified" ? ` (${lead.policy_product})` : ""}`.slice(0, 300),
        body: body.slice(0, 2000),
        lead_id: lead.id,
        event_id: event.id,
        milestone: event.milestone,
      });
    }

    // Escalation: a T-10 or T-3 reminder went to an agent who has done
    // nothing on the lead (no edit, status change, note, contact or task)
    // for ESCALATE_AFTER_DAYS. Every admin hears about it, once per
    // milestone (the unique (event_id, user_id) index). Admins who already
    // got the reminder itself (unassigned leads) are not told twice.
    const late = escalating.get(lead.id);
    if (late && agent && active.has(agent) && lead.last_activity_at < quietSince) {
      const agentName = active.get(agent)?.full_name ?? "the agent";
      const last = lead.last_activity_at ? `Last activity ${formatDateTime(lead.last_activity_at)}` : "No activity yet";
      for (const admin of admins) {
        if (admin === agent) continue;
        rows.push({
          user_id: admin,
          kind: "other",
          title: `No action in ${ESCALATE_AFTER_DAYS} days: ${lead.client_name} renewal (${late.milestone})`.slice(0, 300),
          body: `${agentName} got the ${late.milestone} reminder. Renews ${formatDate(lead.renewal_date)}. ${last}. Status: ${lead.status}.`.slice(0, 2000),
          lead_id: lead.id,
          event_id: late.id,
          milestone: late.milestone,
        });
      }
    }
  }

  // Marking and notifying in one batch, guarded so a run that overlaps
  // another cannot send twice (the unique (event_id, user_id) index also does).
  const statements: BatchItem<"sqlite">[] = [];
  const ids = due.map((e) => e.id);
  for (let i = 0; i < ids.length; i += 90) {
    statements.push(
      ctx.db
        .update(events)
        .set({ reminder_sent_at: stamp })
        .where(and(inArray(events.id, ids.slice(i, i + 90)), isNull(events.reminder_sent_at))),
    );
  }
  for (let i = 0; i < rows.length; i += 10) {
    statements.push(ctx.db.insert(notifications).values(rows.slice(i, i + 10)).onConflictDoNothing());
  }
  await ctx.db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return rows.length;
}

/** "2:30 PM" in business time (the app's default clock). */
function clockTime(timestamp: string): string {
  const parts = parseHhmm(businessHhmm(timestamp));
  if (!parts) return "";
  const { hour, period } = to12Hour(parts.hours);
  return `${hour}:${String(parts.minutes).padStart(2, "0")} ${period}`;
}

/** A meeting reminds this long before it starts; a task reminds when it falls due. */
export const MEETING_LEAD_MS = 15 * 60_000;
/**
 * Tasks and meetings due longer ago than this get no reminder (the cron was
 * down, or they were already overdue when this feature arrived). They still
 * show as overdue on My Day.
 */
const TASK_REMINDER_WINDOW_MS = 60 * 60_000;

/**
 * Reminds people of their tasks and meetings: a meeting 15 minutes before it
 * starts, a task when it falls due. One bell (and browser push) message for
 * the person it is assigned to, when they are active. Each task is claimed
 * (reminder_sent_at) before its message is written, so overlapping cron runs
 * cannot send it twice; moving a task to a new time clears the claim, so the
 * new time reminds again. Renewal milestones are not tasks here.
 * Returns notifications created.
 */
export async function deliverTaskReminders(ctx: DataContext, at: Date = new Date(), limit = REMINDER_BATCH): Promise<number> {
  const from = new Date(at.getTime() - TASK_REMINDER_WINDOW_MS).toISOString();
  const until = new Date(at.getTime() + MEETING_LEAD_MS).toISOString();
  const candidates = await ctx.db
    .select({
      id: events.id,
      kind: events.kind,
      title: events.title,
      notes: events.notes,
      event_timestamp: events.event_timestamp,
      assigned_agent_id: events.assigned_agent_id,
      lead_id: events.lead_id,
      lead_name: leads.client_name,
    })
    .from(events)
    .leftJoin(leads, eq(leads.id, events.lead_id))
    .where(
      and(
        eq(events.is_system_generated, false),
        eq(events.is_background_reminder, false),
        eq(events.is_completed, false),
        isNull(events.reminder_sent_at),
        isNotNull(events.assigned_agent_id),
        gt(events.event_timestamp, from),
        lte(events.event_timestamp, until),
      ),
    )
    .orderBy(asc(events.event_timestamp))
    .limit(Math.max(limit, 1));

  const now = at.getTime();
  const due = candidates.filter((e) => {
    const start = Date.parse(e.event_timestamp);
    return e.kind === "meeting" ? start - MEETING_LEAD_MS <= now : start <= now;
  });
  if (due.length === 0) return 0;

  const stamp = at.toISOString();
  const claimed = new Set<number>();
  for (let i = 0; i < due.length; i += 90) {
    const ids = due.slice(i, i + 90).map((e) => e.id);
    const rows = await ctx.db
      .update(events)
      .set({ reminder_sent_at: stamp })
      .where(and(inArray(events.id, ids), isNull(events.reminder_sent_at)))
      .returning({ id: events.id });
    for (const row of rows) claimed.add(row.id);
  }

  const people = await ctx.db.select({ id: profiles.id, is_active: profiles.is_active }).from(profiles);
  const active = new Set(people.filter((p) => p.is_active).map((p) => p.id));
  const rows: (typeof notifications.$inferInsert)[] = [];
  for (const event of due) {
    if (!claimed.has(event.id) || !event.assigned_agent_id || !active.has(event.assigned_agent_id)) continue;
    const meeting = event.kind === "meeting";
    const when = clockTime(event.event_timestamp);
    const details = [event.lead_name ? `Lead: ${event.lead_name}` : "", event.notes.trim()].filter(Boolean).join(". ");
    rows.push({
      user_id: event.assigned_agent_id,
      kind: "other",
      title: (meeting ? `Meeting at ${when}: ${event.title}` : `Task due ${when}: ${event.title}`).slice(0, 300),
      body: (details || (meeting ? "Starts in 15 minutes." : "Due now.")).slice(0, 2000),
      lead_id: event.lead_id,
      // Not tied to event_id: a task moved to a new time must be able to remind again.
      event_id: null,
    });
  }
  for (let i = 0; i < rows.length; i += 10) {
    await ctx.db.insert(notifications).values(rows.slice(i, i + 10));
  }
  return rows.length;
}
