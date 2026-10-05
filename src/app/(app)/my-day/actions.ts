"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { isAdmin, requireProfile } from "@/lib/auth";
import { businessDateTimeToIso, todayInBusinessTz } from "@/lib/dates";
import { createClient } from "@/lib/supabase/server";

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

/** Quick task from My Day. Agents plan for themselves; admins can assign to anyone active. */
export async function createTask(formData: FormData): Promise<TaskResult> {
  const profile = await requireProfile();
  const parsed = taskSchema.safeParse({
    title: formData.get("title") ?? "",
    date: formData.get("date") ?? "",
    time: formData.get("time") ?? "",
    assignee: formData.get("assignee") ?? "",
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the task." };
  const { title, date, time, assignee } = parsed.data;

  const assignedTo = isAdmin(profile) && assignee ? assignee : profile.id;
  const supabase = await createClient();
  const { error } = await supabase.from("events").insert({
    title,
    event_timestamp: businessDateTimeToIso(date || todayInBusinessTz(), time || "10:00"),
    assigned_agent_id: assignedTo,
  });
  if (error) return { ok: false, error: error.code === "42501" ? "You can't assign tasks to that person." : error.message };
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function setTaskDone(eventId: number, done: boolean): Promise<TaskResult> {
  await requireProfile();
  const supabase = await createClient();
  const { error } = await supabase
    .from("events")
    .update({ is_completed: done })
    .eq("id", eventId)
    .select("id")
    .single();
  if (error) return { ok: false, error: "That task isn't yours or no longer exists." };
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function deleteTask(eventId: number): Promise<TaskResult> {
  await requireProfile();
  const supabase = await createClient();
  const { error } = await supabase.from("events").delete().eq("id", eventId).select("id").single();
  if (error) return { ok: false, error: "Renewal events can't be deleted; complete them instead." };
  revalidatePath("/", "layout");
  return { ok: true };
}
