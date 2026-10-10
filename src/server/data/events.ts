import "server-only";

import { and, asc, eq, gte, lte } from "drizzle-orm";

import { events, leads, profiles } from "../db/schema";
import { isAdmin, type Actor } from "./actor";
import type { DataContext } from "./context";
import { AccessDeniedError, InvalidInputError } from "./errors";

// Calendar events: renewal milestones (made by the server, see leads.ts) and
// tasks people add. Agents see and manage their own; admins everyone's.
// Milestones cannot be edited or deleted by hand, only completed.

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

export type NewTask = {
  title: string;
  event_timestamp: string;
  notes?: string;
  lead_id?: number | null;
  assigned_agent_id?: string | null;
};

/** A task. Agents plan for themselves; admins can assign to anyone active. */
export async function createTask(ctx: DataContext, actor: Actor, input: NewTask): Promise<CalendarEvent> {
  const title = input.title.trim();
  if (!title) throw new InvalidInputError("Describe the task.");
  if (title.length > 300) throw new InvalidInputError("Keep the task under 300 characters.");
  if (Number.isNaN(Date.parse(input.event_timestamp))) throw new InvalidInputError("Pick a valid date.");

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
  const [event] = await ctx.db
    .insert(events)
    .values({
      title,
      event_timestamp: new Date(input.event_timestamp).toISOString(),
      notes: (input.notes ?? "").trim().slice(0, 5000),
      lead_id: input.lead_id ?? null,
      assigned_agent_id: assignee,
      created_by: actor.id,
    })
    .returning();
  return event;
}

export async function setEventDone(ctx: DataContext, actor: Actor, id: number, done: boolean): Promise<void> {
  await findVisible(ctx, actor, id);
  await ctx.db
    .update(events)
    .set({ is_completed: done, completed_at: done ? new Date().toISOString() : null })
    .where(eq(events.id, id));
}

/** Deletes a task. Renewal milestones go only when the renewal date changes. */
export async function deleteTask(ctx: DataContext, actor: Actor, id: number): Promise<void> {
  const event = await findVisible(ctx, actor, id);
  if (event.is_system_generated && !isAdmin(actor)) {
    throw new AccessDeniedError("Renewal reminders follow the lead's renewal date.");
  }
  await ctx.db.delete(events).where(eq(events.id, id));
}
