import "server-only";

import { and, asc, count, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import { formatDate } from "@/lib/dates";
import { CLOSED_STATUSES } from "@/lib/domain";

import { events, leads, notifications, profiles } from "../db/schema";
import type { Actor } from "./actor";
import type { DataContext } from "./context";

// The reminder bell. Notifications are created only by deliverDueReminders()
// (the per-minute cron); people can only read and dismiss their own.

export type Notification = typeof notifications.$inferSelect;

export async function recentNotifications(ctx: DataContext, actor: Actor, limit = 20) {
  const [items, [unread]] = await Promise.all([
    ctx.db
      .select()
      .from(notifications)
      .where(eq(notifications.user_id, actor.id))
      .orderBy(desc(notifications.created_at), desc(notifications.id))
      .limit(limit),
    ctx.db
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.user_id, actor.id), isNull(notifications.read_at))),
  ]);
  return { items, unread: unread?.n ?? 0 };
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
 * Sends due renewal reminders. Marks every due background reminder as sent;
 * for each open lead, the latest due milestone becomes one notification for
 * its agent, or for every active admin when the lead has no active agent.
 * Safe to run again: a reminder is sent once. Returns notifications created.
 */
export async function deliverDueReminders(ctx: DataContext, at: Date = new Date(), limit = 1000): Promise<number> {
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

  const leadIds = [...latest.keys()];
  const [leadRows, team] = await Promise.all([
    leadIds.length
      ? ctx.db.select().from(leads).where(inArray(leads.id, leadIds))
      : Promise.resolve([] as (typeof leads.$inferSelect)[]),
    ctx.db.select({ id: profiles.id, role: profiles.role, is_active: profiles.is_active }).from(profiles),
  ]);
  const active = new Map(team.filter((p) => p.is_active).map((p) => [p.id, p]));
  const admins = [...active.values()].filter((p) => p.role === "ADMIN").map((p) => p.id);

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
        title: `${event.milestone}: ${lead.client_name} renewal (${lead.policy_product})`.slice(0, 300),
        body: body.slice(0, 2000),
        lead_id: lead.id,
        event_id: event.id,
        milestone: event.milestone,
      });
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
