"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { friendlyError } from "@/lib/action-errors";
import { AiRateLimitError, AiUnavailableError, generate } from "@/lib/ai/client";
import { MAX_OUTPUT_TOKENS, MODEL_CHAINS } from "@/lib/ai/models";
import { taskSummaryPrompt } from "@/lib/ai/prompts";
import { getSession } from "@/lib/auth";
import { formatDateTime } from "@/lib/dates";
import { dueDateToIso, suggestDueFromRenewal, threadDigest, type DueSuggestion } from "@/lib/work-tasks";
import * as tasks from "@/server/data/work-tasks";

export type TaskActionResult = { ok: true; id?: number } | { ok: false; error: string };

const SIGNED_OUT = { ok: false as const, error: "Your session has ended. Sign in again." };

const formSchema = z.object({
  title: z.string().trim().min(1, "Give the task a title.").max(200, "Keep the title under 200 characters."),
  description: z.string().trim().max(5000, "Keep the details under 5,000 characters."),
  priority: z.enum(["P1", "P2", "P3"]).catch("P2"),
  due_date: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v), "Pick a valid due date."),
  due_time: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{2}:\d{2}$/.test(v), "Pick a valid time."),
  assignee: z.string().trim(),
  tags: z.string().trim().max(400),
  lead_id: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{1,12}$/.test(v), "Pick a lead from the list.")
    .transform((v) => (v ? Number(v) : null)),
});

function parseForm(formData: FormData) {
  return formSchema.safeParse({
    title: formData.get("title") ?? "",
    description: formData.get("description") ?? "",
    priority: formData.get("priority") ?? "P2",
    due_date: formData.get("due_date") ?? "",
    due_time: formData.get("due_time") ?? "",
    assignee: formData.get("assignee") ?? "",
    tags: formData.get("tags") ?? "",
    lead_id: formData.get("lead_id") ?? "",
  });
}

function done(): void {
  revalidatePath("/tasks", "layout");
  revalidatePath("/my-day");
}

export async function createWorkTaskAction(formData: FormData): Promise<TaskActionResult> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  const parsed = parseForm(formData);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the task." };
  const f = parsed.data;
  try {
    const task = await tasks.createWorkTask(session.ctx, session.actor, {
      title: f.title,
      description: f.description,
      priority: f.priority,
      due_at: f.due_date ? dueDateToIso(f.due_date, f.due_time || undefined) : null,
      assignee_id: f.assignee || session.actor.id,
      lead_id: f.lead_id,
      tags: f.tags,
      autoTag: formData.get("auto_tag") !== "off",
    });
    done();
    return { ok: true, id: task.id };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}

export async function updateWorkTaskAction(id: number, formData: FormData): Promise<TaskActionResult> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  const parsed = parseForm(formData);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the task." };
  const f = parsed.data;
  try {
    await tasks.updateWorkTask(session.ctx, session.actor, Number(id), {
      title: f.title,
      description: f.description,
      priority: f.priority,
      due_at: f.due_date ? dueDateToIso(f.due_date, f.due_time || undefined) : null,
      assignee_id: f.assignee || undefined,
      lead_id: f.lead_id,
      tags: f.tags,
    });
    done();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}

async function run(fn: (s: NonNullable<Awaited<ReturnType<typeof getSession>>>) => Promise<unknown>): Promise<TaskActionResult> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  try {
    await fn(session);
    done();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}

export async function setWorkTaskStatusAction(id: number, status: string, note?: string): Promise<TaskActionResult> {
  return run((s) => tasks.setWorkTaskStatus(s.ctx, s.actor, Number(id), String(status), note ? String(note) : undefined));
}

export async function postTaskMessageAction(id: number, body: string, via: "text" | "voice"): Promise<TaskActionResult> {
  return run((s) => tasks.postTaskMessage(s.ctx, s.actor, Number(id), { body: String(body ?? ""), via: via === "voice" ? "voice" : "text" }));
}

export async function nudgeWorkTaskAction(id: number): Promise<TaskActionResult> {
  return run((s) => tasks.nudgeWorkTask(s.ctx, s.actor, Number(id)));
}

export async function deleteWorkTaskAction(id: number): Promise<TaskActionResult> {
  return run((s) => tasks.deleteWorkTask(s.ctx, s.actor, Number(id)));
}

/** Opening a task marks its thread and bell items read (from the page, not on prefetch). */
export async function markTaskReadAction(id: number): Promise<TaskActionResult> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  try {
    await tasks.markTaskRead(session.ctx, session.actor, Number(id));
    revalidatePath("/my-day");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}

export type LeadSuggestion = { ok: true; due: DueSuggestion | null; tags: string[] } | { ok: false; error: string };

/** A due date and tags for a task about this lead, from its renewal date and product (rules, no AI). */
export async function suggestFromLeadAction(leadId: number): Promise<LeadSuggestion> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  try {
    const lead = await tasks.leadTaskContext(session.ctx, session.actor, Number(leadId));
    if (!lead) return { ok: true, due: null, tags: [] };
    return { ok: true, due: suggestDueFromRenewal(lead.renewal_date), tags: lead.tags };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}

export type SummaryResult = { ok: true; text: string; source: "ai" | "rules"; notice?: string } | { ok: false; error: string };

/** A catch-up on a long thread: AI when it is set up, else a rule-based digest. */
export async function summarizeTaskAction(id: number): Promise<SummaryResult> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  const { ctx, actor } = session;
  const thread = await tasks.getTaskThread(ctx, actor, Number(id));
  if (!thread) return { ok: false, error: "That task no longer exists or isn't yours." };
  const { task, messages } = thread;
  const fallback = () => threadDigest(task, messages);
  if (messages.filter((m) => m.kind === "message").length < 2) return { ok: true, text: fallback(), source: "rules" };

  const transcript = messages
    .slice(-60)
    .map((m) => `[${formatDateTime(m.created_at)}] ${m.kind === "system" ? "(update) " : ""}${m.author_name}: ${m.body.slice(0, 600)}`)
    .join("\n");
  try {
    const { value } = await generate({
      ctx,
      user: actor,
      feature: "other",
      models: MODEL_CHAINS.writing,
      system: taskSummaryPrompt(),
      maxOutputTokens: MAX_OUTPUT_TOKENS.taskSummary,
      text: `Task: ${task.title}\nStatus: ${task.status}\nAssigned to: ${task.assignee_name ?? "unknown"} by ${task.created_by_name}\n${task.description ? `Details: ${task.description.slice(0, 1000)}\n` : ""}\nThread:\n${transcript}`,
      parse: (text) => {
        const clean = text.trim();
        if (!clean) throw new Error("Empty summary");
        return clean.slice(0, 1200);
      },
    });
    return { ok: true, text: value, source: "ai" };
  } catch (error) {
    if (error instanceof AiRateLimitError) return { ok: false, error: error.message };
    if (!(error instanceof AiUnavailableError)) return { ok: false, error: friendlyError(error) };
    return { ok: true, text: fallback(), source: "rules", notice: error.message };
  }
}
