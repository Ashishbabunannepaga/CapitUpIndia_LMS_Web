import "server-only";

import { generate, parseJsonObject } from "@/lib/ai/client";
import { MAX_OUTPUT_TOKENS, MODEL_CHAINS } from "@/lib/ai/models";
import { taskCopilotAskPrompt, taskCopilotDraftPrompt } from "@/lib/ai/prompts";
import { taskDraftsSchema } from "@/lib/ai/schemas";
import { isIsoDate, todayInBusinessTz } from "@/lib/dates";
import { dueState, isTaskPriority, parseTags, TASK_STATUS_LABELS, waitingOn, type TaskPriority } from "@/lib/work-tasks";

import { isAdmin, type Actor } from "./data/actor";
import type { DataContext } from "./data/context";
import * as tasks from "./data/work-tasks";

// The Task Grid copilot, shared by the app (Tasks > Copilot) and WhatsApp.
// "Ask" answers from the tasks the person can already see (same rules as the
// board, so nothing private leaks). "Drafts" turns a sentence into tasks; the
// app shows them for a check first, WhatsApp creates them straight away. Both
// use the cheapest model chain and throw the AI client's errors.

export const MAX_QUESTION = 500;
const SNAPSHOT_TASKS = 150;

const dateTime = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

/** Answers a question about the caller's tasks. `extra` adds more facts (WhatsApp adds renewals and leads). */
export async function copilotAnswer(ctx: DataContext, actor: Actor, question: string, extra = ""): Promise<string> {
  const q = question.trim().slice(0, MAX_QUESTION);
  const admin = isAdmin(actor);
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
    extra ? `\nMore facts about the user's own work:\n${extra}` : "",
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
  return value;
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

/** Turns a request into up to 8 task drafts; anyone the person can't give work to falls back to them. */
export async function copilotDrafts(ctx: DataContext, actor: Actor, request: string): Promise<TaskDraft[]> {
  const ask = request.trim().slice(0, 1500);
  const admin = isAdmin(actor);
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
  return value;
}
