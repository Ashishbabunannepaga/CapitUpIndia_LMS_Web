import "server-only";

import { and, asc, eq, gte, lte } from "drizzle-orm";

import { calendarCategories, isEventKind, type CalendarCategory, type EventKind } from "@/lib/domain";

import { events, leads, profiles } from "../db/schema";
import { isAdmin, type Actor } from "./actor";
import { auditInsert } from "./audit";
import type { DataContext } from "./context";
import { AccessDeniedError, InvalidInputError } from "./errors";

// Calendar events: renewal milestones (made by the server, see leads.ts) and
// the tasks and meetings people add. Agents see and manage their own; admins
// everyone's. Milestones cannot be edited or deleted by hand, only completed.

export type CalendarEvent = typeof events.$inferSelect;

function scope(actor: Actor) {
  return isAdmin(actor) ? undefined : eq(events.assigned_agent_id, actor.id);
}

async function findVisible(ctx: DataContext, actor: Actor, id: number): Promise<CalendarEvent> {
  const event = await ctx.db.query.events.findFirst({ where: and(eq(events.id, id), scope(actor)) });
  if (!event) throw new InvalidInputError("That task no longer exists or isn't yours.");
  return event;
}

/** Visible (non-background) events between two timestamps, oldest first. */
export async function listEvents(
  ctx: DataContext,
  actor: Actor,
  range: { from: string; to: string; limit?: number },
): Promise<CalendarEvent[]> {
  return ctx.db
    .select()
    .from(events)
    .where(
      and(
        scope(actor),
        eq(events.is_background_reminder, false),
        gte(events.event_timestamp, range.from),
        lte(events.event_timestamp, range.to),
      ),
    )
    .orderBy(asc(events.event_timestamp))
    .limit(Math.min(range.limit ?? 1000, 2000));
}

export type CalendarEventWithCategories = CalendarEvent & { lead_name: string | null; categories: CalendarCategory[] };

/**
 * The same events as listEvents, each with its calendar colours (GMC or
 * retail renewal, active client, task), worked out from its lead.
 */
export async function listCalendarEvents(
  ctx: DataContext,
  actor: Actor,
  range: { from: string; to: string; limit?: number },
): Promise<CalendarEventWithCategories[]> {
  const rows = await ctx.db
    .select({
      event: events,
      lead_name: leads.client_name,
      business_type: leads.business_type,
      policy_product: leads.policy_product,
      status: leads.status,
    })
    .from(events)
    .leftJoin(leads, eq(leads.id, events.lead_id))
    .where(
      and(
        scope(actor),
        eq(events.is_background_reminder, false),
        gte(events.event_timestamp, range.from),
        lte(events.event_timestamp, range.to),
      ),
    )
    .orderBy(asc(events.event_timestamp))
    .limit(Math.min(range.limit ?? 1000, 2000));
  return rows.map(({ event, lead_name, business_type, policy_product, status }) => ({
    ...event,
    lead_name,
    categories: calendarCategories(
      event.is_system_generated,
      business_type && policy_product && status ? { business_type, policy_product, status } : null,
      event.kind,
    ),
  }));
}

export type NewTask = {
  title: string;
  event_timestamp: string;
  notes?: string;
  lead_id?: number | null;
  assigned_agent_id?: string | null;
  /** Task (default) or meeting. */
  kind?: EventKind;
};

/** Checks and tidies what someone typed for a task or meeting. */
async function checkedTask(ctx: DataContext, actor: Actor, input: NewTask) {
  const title = input.title.trim();
  if (!title) throw new InvalidInputError("Describe the task.");
  if (title.length > 300) throw new InvalidInputError("Keep the task under 300 characters.");
  if (Number.isNaN(Date.parse(input.event_timestamp))) throw new InvalidInputError("Pick a valid date.");
  const notes = (input.notes ?? "").trim();
  if (notes.length > 5000) throw new InvalidInputError("Keep the details under 5,000 characters.");
  const kind = input.kind ?? "task";
  if (!isEventKind(kind)) throw new InvalidInputError("Pick task or meeting.");

  const assignee = input.assigned_agent_id || actor.id;
  if (assignee !== actor.id) {
    if (!isAdmin(actor)) throw new AccessDeniedError("You can't assign tasks to that person.");
    const member = await ctx.db.query.profiles.findFirst({ where: eq(profiles.id, assignee) });
    if (!member?.is_active) throw new InvalidInputError("Pick an active team member.");
  }
  if (input.lead_id) {
    const lead = await ctx.db.query.leads.findFirst({
      where: and(eq(leads.id, input.lead_id), isAdmin(actor) ? undefined : eq(leads.assigned_agent_id, actor.id)),
    });
    if (!lead) throw new InvalidInputError("That lead no longer exists or isn't yours.");
  }
  return {
    title,
    event_timestamp: new Date(input.event_timestamp).toISOString(),
    notes,
    kind,
    lead_id: input.lead_id || null,
    assigned_agent_id: assignee,
  };
}

/** A task or meeting. Agents plan for themselves; admins can assign to anyone active. */
export async function createTask(ctx: DataContext, actor: Actor, input: NewTask): Promise<CalendarEvent> {
  const values = await checkedTask(ctx, actor, input);
  const [event] = await ctx.db
    .insert(events)
    .values({ ...values, created_by: actor.id })
    .returning();
  return event;
}

/**
 * Edits a task or meeting: what, when, details, linked lead and (admins) who.
 * Renewal milestones follow the lead's renewal date, so they cannot be edited.
 */
export async function updateTask(ctx: DataContext, actor: Actor, id: number, input: NewTask): Promise<CalendarEvent> {
  const event = await findVisible(ctx, actor, id);
  if (event.is_system_generated) throw new AccessDeniedError("Renewal reminders follow the lead's renewal date.");
  // An agent's own task stays theirs; admins may move it (or keep it with its current owner).
  const values = await checkedTask(ctx, actor, {
    ...input,
    assigned_agent_id: isAdmin(actor) ? (input.assigned_agent_id ?? event.assigned_agent_id) : actor.id,
  });
  const summary = (e: Pick<CalendarEvent, "title" | "lead_id" | "event_timestamp" | "kind">) => ({
    title: e.title,
    lead_id: e.lead_id,
    event_timestamp: e.event_timestamp,
    kind: e.kind,
  });
  const [[updated]] = await ctx.db.batch([
    ctx.db.update(events).set(values).where(eq(events.id, id)).returning(),
    auditInsert(ctx, actor, "events", id, "UPDATE", summary(event), summary(values)),
  ]);
  if (!updated) throw new InvalidInputError("That task no longer exists or isn't yours.");
  return updated;
}

export async function setEventDone(ctx: DataContext, actor: Actor, id: number, done: boolean): Promise<void> {
  const event = await findVisible(ctx, actor, id);
  if (event.is_completed === done) return;
  const completed_at = done ? new Date().toISOString() : null;
  // The audit row records who ticked it off, for the admins' activity log.
  const summary = { title: event.title, lead_id: event.lead_id, milestone: event.milestone };
  await ctx.db.batch([
    ctx.db.update(events).set({ is_completed: done, completed_at }).where(eq(events.id, id)),
    auditInsert(ctx, actor, "events", id, "UPDATE", { ...summary, is_completed: event.is_completed }, { ...summary, is_completed: done, completed_at }),
  ]);
}

/** Deletes a task. Renewal milestones go only when the renewal date changes. */
export async function deleteTask(ctx: DataContext, actor: Actor, id: number): Promise<void> {
  const event = await findVisible(ctx, actor, id);
  if (event.is_system_generated && !isAdmin(actor)) {
    throw new AccessDeniedError("Renewal reminders follow the lead's renewal date.");
  }
  await ctx.db.delete(events).where(eq(events.id, id));
}
