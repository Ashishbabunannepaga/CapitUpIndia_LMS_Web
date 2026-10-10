"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { friendlyError } from "@/lib/action-errors";
import { getSession, isAdmin } from "@/lib/auth";
import { businessDateTimeToIso, todayInBusinessTz } from "@/lib/dates";
import * as events from "@/server/data/events";

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
});

const SIGNED_OUT: TaskResult = { ok: false, error: "Your session has ended. Sign in again." };

/** Quick task from My Day. Agents plan for themselves; admins can assign to anyone active. */
export async function createTask(formData: FormData): Promise<TaskResult> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  const { ctx, actor } = session;
  const parsed = taskSchema.safeParse({
    title: formData.get("title") ?? "",
    date: formData.get("date") ?? "",
    time: formData.get("time") ?? "",
    assignee: formData.get("assignee") ?? "",
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the task." };
  const { title, date, time, assignee } = parsed.data;

  try {
    await events.createTask(ctx, actor, {
      title,
      event_timestamp: businessDateTimeToIso(date || todayInBusinessTz(), time || "10:00"),
      assigned_agent_id: isAdmin(actor) && assignee ? assignee : actor.id,
    });
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
  revalidatePath("/", "layout");
  return { ok: true };
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
