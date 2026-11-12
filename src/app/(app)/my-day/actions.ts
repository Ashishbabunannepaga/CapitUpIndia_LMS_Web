"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { friendlyError } from "@/lib/action-errors";
import { getSession, isAdmin } from "@/lib/auth";
import { businessDateTimeToIso, todayInBusinessTz } from "@/lib/dates";
import { EVENT_KINDS } from "@/lib/domain";
import * as events from "@/server/data/events";
import { pickLeads, type LeadChoice } from "@/server/data/leads";

export type TaskResult = { ok: true } | { ok: false; error: string };

const taskSchema = z.object({
  title: z.string().trim().min(1, "Describe the task.").max(300, "Keep the task under 300 characters."),
  date: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v), "Pick a valid date."),
  time: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{2}:\d{2}$/.test(v), "Pick a valid time."),
  assignee: z.string().trim(),
  kind: z.enum(EVENT_KINDS).catch("task"),
  notes: z.string().trim().max(5000, "Keep the details under 5,000 characters."),
  lead_id: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{1,12}$/.test(v), "Pick a lead from the list.")
    .transform((v) => (v ? Number(v) : null)),
});

function parseTask(formData: FormData) {
  return taskSchema.safeParse({
    title: formData.get("title") ?? "",
    date: formData.get("date") ?? "",
    time: formData.get("time") ?? "",
    assignee: formData.get("assignee") ?? "",
    kind: formData.get("kind") ?? "task",
    notes: formData.get("notes") ?? "",
    lead_id: formData.get("lead_id") ?? "",
  });
}

const SIGNED_OUT: TaskResult = { ok: false, error: "Your session has ended. Sign in again." };

/**
 * A task or meeting from My Day, the calendar or a lead page. Agents plan for
 * themselves; admins can assign to anyone active.
 */
export async function createTask(formData: FormData): Promise<TaskResult> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  const { ctx, actor } = session;
  const parsed = parseTask(formData);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the task." };
  const { title, date, time, assignee, kind, notes, lead_id } = parsed.data;

  try {
    await events.createTask(ctx, actor, {
      title,
      kind,
      notes,
      lead_id,
      event_timestamp: businessDateTimeToIso(date || todayInBusinessTz(), time || "10:00"),
      assigned_agent_id: isAdmin(actor) && assignee ? assignee : actor.id,
    });
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Edits a task or meeting the caller can see (renewal reminders cannot be edited). */
export async function updateTask(eventId: number, formData: FormData): Promise<TaskResult> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  const { ctx, actor } = session;
  const parsed = parseTask(formData);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the task." };
  const { title, date, time, assignee, kind, notes, lead_id } = parsed.data;
  if (!date) return { ok: false, error: "Pick a valid date." };

  try {
    await events.updateTask(ctx, actor, eventId, {
      title,
      kind,
      notes,
      lead_id,
      event_timestamp: businessDateTimeToIso(date, time || "10:00"),
      // Agents keep their own tasks; an admin's form says who it is for.
      assigned_agent_id: isAdmin(actor) && assignee ? assignee : undefined,
    });
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Leads to link a task or meeting to, by company name. */
export async function findLeadsForTask(query: string): Promise<LeadChoice[]> {
  const session = await getSession();
  if (!session) return [];
  return pickLeads(session.ctx, session.actor, String(query ?? ""));
}

export async function setTaskDone(eventId: number, done: boolean): Promise<TaskResult> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  try {
    await events.setEventDone(session.ctx, session.actor, eventId, done);
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function deleteTask(eventId: number): Promise<TaskResult> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  try {
    await events.deleteTask(session.ctx, session.actor, eventId);
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}
