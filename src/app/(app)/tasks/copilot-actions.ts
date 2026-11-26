"use server";

import { revalidatePath } from "next/cache";

import { friendlyError } from "@/lib/action-errors";
import { AiRateLimitError, AiUnavailableError, generate, parseJsonObject } from "@/lib/ai/client";
import { MAX_OUTPUT_TOKENS, MODEL_CHAINS } from "@/lib/ai/models";
import { taskCopilotAskPrompt, taskCopilotDraftPrompt } from "@/lib/ai/prompts";
import { taskDraftsSchema } from "@/lib/ai/schemas";
import { getSession, isAdmin } from "@/lib/auth";
import { isIsoDate, todayInBusinessTz } from "@/lib/dates";
import { dueDateToIso, dueState, isTaskPriority, parseTags, TASK_STATUS_LABELS, waitingOn, type TaskPriority } from "@/lib/work-tasks";
import * as tasks from "@/server/data/work-tasks";

// Task Grid copilot. "Ask" answers questions about the tasks the caller can
// already see (same rules as the board; nothing private leaks to anyone
// else). "Create" turns a sentence into task drafts that the person checks
// before anything is saved. Both use the cheapest model chain.

const SIGNED_OUT = { ok: false as const, error: "Your session has ended. Sign in again." };
const MAX_QUESTION = 500;
const SNAPSHOT_TASKS = 150;

const dateTime = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

function aiError(error: unknown): { ok: false; error: string } {
  if (error instanceof AiRateLimitError || error instanceof AiUnavailableError) return { ok: false, error: error.message };
  return { ok: false, error: friendlyError(error) };
}

export type CopilotAnswer = { ok: true; answer: string } | { ok: false; error: string };

export async function copilotAskAction(question: string): Promise<CopilotAnswer> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  const { ctx, actor } = session;
  const q = String(question ?? "").trim().slice(0, MAX_QUESTION);
  if (!q) return { ok: false, error: "Ask a question first." };
  const admin = isAdmin(actor);

  try {
    const [open, recipients] = await Promise.all([tasks.listTasks(ctx, actor, { status: "open" }), tasks.taskRecipients(ctx, actor)]);
    const now = new Date();
    const lines = open.slice(0, SNAPSHOT_TASKS).map((t) => {
      const waiting = waitingOn(t, t.last_message?.author_id ?? null);
      const onUser = (waiting === "giver" && t.created_by === actor.id) || (waiting === "assignee" && t.assignee_id === actor.id && t.kind === "assigned");
      const due = t.due_at ? `${dateTime.format(new Date(t.due_at))}${dueState(t.due_at, now) === "overdue" ? " (OVERDUE)" : ""}` : "no deadline";
      const who =
        t.kind === "personal"
          ? "user's private to-do"
          : `for ${t.assignee_id === actor.id ? "the user" : t.assignee_name}, ${t.raised ? "raised" : "given"} by ${t.created_by === actor.id ? "the user" : t.created_by_name}`;
      const last = t.last_message ? `; last message from ${t.last_message.author_id === actor.id ? "the user" : t.last_message.author_name}: "${t.last_message.body.slice(0, 120)}"` : "";
      return `- "${t.title}" [${t.priority}, ${TASK_STATUS_LABELS[t.status]}, due ${due}] ${who}${t.lead_name ? `, lead ${t.lead_name}` : ""}${t.tags.length ? `, tags ${t.tags.join("/")}` : ""}${onUser ? ", WAITING ON THE USER" : ""}${t.unread ? `, ${t.unread} unread` : ""}${last}`;
    });
    const load = new Map<string, number>();
    for (const t of open) if (t.kind === "assigned") load.set(t.assignee_name ?? "?", (load.get(t.assignee_name ?? "?") ?? 0) + 1);
    const text = [
      `User: ${actor.full_name} (${admin ? "admin" : "agent"})`,
      `Team: ${recipients.map((r) => `${r.full_name} (${r.role === "ADMIN" ? "admin" : "agent"})`).join(", ")}`,
      admin ? `Open assigned tasks per person: ${[...load].map(([n, c]) => `${n} ${c}`).join(", ") || "none"}` : "",
      `Open tasks (${open.length}${open.length > SNAPSHOT_TASKS ? `, first ${SNAPSHOT_TASKS} shown` : ""}):`,
      lines.join("\n") || "(none)",
      "",
      `Question: ${q}`,
    ]
      .filter(Boolean)
      .join("\n");

    const { value } = await generate({
      ctx,
      user: actor,
      feature: "other",
      models: MODEL_CHAINS.summary,
      system: taskCopilotAskPrompt(todayInBusinessTz(now), admin),
      maxOutputTokens: MAX_OUTPUT_TOKENS.copilotAnswer,
      text,
      parse: (out) => {
        const clean = out.trim();
        if (!clean) throw new Error("Empty answer");
        return clean.slice(0, 3000);
      },
    });
    return { ok: true, answer: value };
  } catch (error) {
    return aiError(error);
  }
}

export type TaskDraft = {
  title: string;
  description: string;
  assignee_id: string;
  assignee_name: string;
  priority: TaskPriority;
  due_date: string;
  tags: string[];
};

export type CopilotDrafts = { ok: true; drafts: TaskDraft[] } | { ok: false; error: string };

export async function copilotDraftAction(request: string): Promise<CopilotDrafts> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  const { ctx, actor } = session;
  const ask = String(request ?? "").trim().slice(0, 1500);
  if (!ask) return { ok: false, error: "Say what needs doing first." };
  const admin = isAdmin(actor);
  try {
    const recipients = await tasks.taskRecipients(ctx, actor);
    const byId = new Map(recipients.map((r) => [r.id, r]));
    const today = todayInBusinessTz();
    const { value } = await generate({
      ctx,
      user: actor,
      feature: "other",
      models: MODEL_CHAINS.summary,
      system: taskCopilotDraftPrompt(today, admin),
      maxOutputTokens: MAX_OUTPUT_TOKENS.copilotDrafts,
      jsonSchema: taskDraftsSchema,
      text: [
        `User id: ${actor.id} (${actor.full_name})`,
        "Team list (id: name, role):",
        ...recipients.map((r) => `${r.id}: ${r.full_name}, ${r.role === "ADMIN" ? "admin" : "agent"}`),
        "",
        `Request: ${ask}`,
      ].join("\n"),
      parse: (out) => {
        const raw = parseJsonObject(out).drafts;
        if (!Array.isArray(raw)) throw new Error("No drafts");
        return raw.slice(0, 8).flatMap((d: Record<string, unknown>): TaskDraft[] => {
          const title = String(d.title ?? "").trim().slice(0, 200);
          if (!title) return [];
          // Anyone the model names who the user can't give work to falls back to the user.
          const member = byId.get(String(d.assignee_id ?? "")) ?? byId.get(actor.id)!;
          const due = String(d.due_date ?? "");
          return [
            {
              title,
              description: String(d.description ?? "").trim().slice(0, 5000),
              assignee_id: member.id,
              assignee_name: member.id === actor.id ? "Me" : member.full_name,
              priority: isTaskPriority(d.priority) ? d.priority : "P2",
              due_date: isIsoDate(due) && due >= today ? due : "",
              tags: parseTags(Array.isArray(d.tags) ? d.tags.map(String) : []),
            },
          ];
        });
      },
    });
    if (!value.length) return { ok: false, error: "The copilot couldn't find a task in that. Try saying who should do what, and by when." };
    return { ok: true, drafts: value };
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
