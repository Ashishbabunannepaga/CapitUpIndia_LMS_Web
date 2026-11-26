"use server";

import { revalidatePath } from "next/cache";

import { friendlyError } from "@/lib/action-errors";
import { AiRateLimitError, AiUnavailableError } from "@/lib/ai/client";
import { getSession } from "@/lib/auth";
import { isIsoDate } from "@/lib/dates";
import { dueDateToIso, isTaskPriority } from "@/lib/work-tasks";
import * as tasks from "@/server/data/work-tasks";
import { copilotAnswer, copilotDrafts, type TaskDraft } from "@/server/task-copilot";

// Task Grid copilot actions. The ask and draft logic lives in
// src/server/task-copilot.ts, shared with WhatsApp. "Create" here only drafts;
// the person checks the drafts before anything is saved.

export type { TaskDraft };

const SIGNED_OUT = { ok: false as const, error: "Your session has ended. Sign in again." };

function aiError(error: unknown): { ok: false; error: string } {
  if (error instanceof AiRateLimitError || error instanceof AiUnavailableError) return { ok: false, error: error.message };
  return { ok: false, error: friendlyError(error) };
}

export type CopilotAnswer = { ok: true; answer: string } | { ok: false; error: string };

export async function copilotAskAction(question: string): Promise<CopilotAnswer> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  const q = String(question ?? "").trim();
  if (!q) return { ok: false, error: "Ask a question first." };
  try {
    return { ok: true, answer: await copilotAnswer(session.ctx, session.actor, q) };
  } catch (error) {
    return aiError(error);
  }
}

export type CopilotDrafts = { ok: true; drafts: TaskDraft[] } | { ok: false; error: string };

export async function copilotDraftAction(request: string): Promise<CopilotDrafts> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  const ask = String(request ?? "").trim();
  if (!ask) return { ok: false, error: "Say what needs doing first." };
  try {
    const drafts = await copilotDrafts(session.ctx, session.actor, ask);
    if (!drafts.length) return { ok: false, error: "The copilot couldn't find a task in that. Try saying who should do what, and by when." };
    return { ok: true, drafts };
  } catch (error) {
    return aiError(error);
  }
}

export type CreateDraftsResult = { ok: true; ids: number[] } | { ok: false; error: string; ids: number[] };

/** Creates the drafts the person kept. Each goes through the normal task rules. */
export async function createFromDraftsAction(drafts: TaskDraft[]): Promise<CreateDraftsResult> {
  const session = await getSession();
  if (!session) return { ...SIGNED_OUT, ids: [] };
  const ids: number[] = [];
  try {
    for (const d of (Array.isArray(drafts) ? drafts : []).slice(0, 8)) {
      const due = String(d.due_date ?? "");
      const task = await tasks.createWorkTask(session.ctx, session.actor, {
        title: String(d.title ?? ""),
        description: String(d.description ?? ""),
        priority: isTaskPriority(d.priority) ? d.priority : "P2",
        due_at: isIsoDate(due) ? dueDateToIso(due) : null,
        assignee_id: String(d.assignee_id || session.actor.id),
        tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
      });
      ids.push(task.id);
    }
    return { ok: true, ids };
  } catch (error) {
    return { ok: false, error: friendlyError(error), ids };
  } finally {
    if (ids.length) {
      revalidatePath("/tasks", "layout");
      revalidatePath("/my-day");
    }
  }
}
