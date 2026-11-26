import { addDays, businessDateTimeToIso, daysBetween, todayInBusinessTz } from "@/lib/dates";

// Task Grid vocabulary and the small rules every screen shares. Values match
// the database CHECKs in src/server/db/schema.ts (work_tasks).

export const TASK_PRIORITIES = ["P1", "P2", "P3"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskKind = "personal" | "assigned";

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  P1: "P1 Urgent",
  P2: "P2 Normal",
  P3: "P3 Low",
};
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

/** Badge colours (Tailwind classes) for priorities and statuses. */
export const TASK_PRIORITY_STYLES: Record<TaskPriority, string> = {
  P1: "border-red-200 bg-red-50 text-red-700",
  P2: "border-amber-200 bg-amber-50 text-amber-800",
  P3: "border-slate-200 bg-slate-50 text-slate-600",
};
export const TASK_STATUS_STYLES: Record<TaskStatus, string> = {
  todo: "border-slate-200 bg-white text-slate-700",
  in_progress: "border-sky-200 bg-sky-50 text-sky-700",
  blocked: "border-red-200 bg-red-50 text-red-700",
  done: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value);
}
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export const MAX_TASK_TAGS = 6;

/** A tag as stored: trimmed, lower case, single spaces, at most 30 characters; "" when nothing is left. */
export function normalizeTag(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s&/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30)
    .trim();
}

/** Tags from a comma-separated string or a list, de-duplicated, at most MAX_TASK_TAGS. */
export function parseTags(input: string | readonly string[]): string[] {
  const parts = typeof input === "string" ? input.split(",") : input;
  return [...new Set(parts.map(normalizeTag).filter(Boolean))].slice(0, MAX_TASK_TAGS);
}

type LeadContext = {
  policy_product: string;
  business_type: string;
  type: string;
  status: string;
  renewal_date: string | null;
};

/**
 * Tags a task picks up from its lead: the product, Corporate or Retail, and
 * "renewal" for a renewal. Rules, not AI: the same lead always gives the same tags.
 */
export function tagsFromLead(lead: LeadContext): string[] {
  const tags: string[] = [];
  if (lead.policy_product && lead.policy_product !== "Not Specified")
    tags.push(lead.policy_product === "Fire or Property" ? "fire" : lead.policy_product);
  if (lead.business_type) tags.push(lead.business_type);
  if (lead.type === "Renewal" || lead.type === "Rollover") tags.push("renewal");
  if (lead.status === "Quoted") tags.push("quote");
  return parseTags(tags);
}

export type DueSuggestion = { date: string; reason: string };

/**
 * A due date for work on a lead that renews: 30 days before the renewal (the
 * usual time to start re-quoting), else 10 days before, else tomorrow when the
 * renewal is closer than that. Null without a renewal date or once it passed.
 */
export function suggestDueFromRenewal(renewalDate: string | null, today: string = todayInBusinessTz()): DueSuggestion | null {
  if (!renewalDate) return null;
  const days = daysBetween(today, renewalDate);
  if (days < 0) return null;
  if (days > 30)
    return {
      date: addDays(renewalDate, -30),
      reason: "30 days before the renewal, time to start re-quoting",
    };
  if (days > 10)
    return {
      date: addDays(renewalDate, -10),
      reason: "10 days before the renewal",
    };
  if (days > 1)
    return {
      date: addDays(today, 1),
      reason: `the renewal is in ${days} days`,
    };
  return {
    date: today,
    reason: days === 0 ? "the renewal is today" : "the renewal is tomorrow",
  };
}

/** The ISO time a due date (business day, India) means: 6 PM that day, end of the working day. */
export function dueDateToIso(date: string, time = "18:00"): string {
  return businessDateTimeToIso(date, time);
}

export type DueState = "none" | "overdue" | "today" | "soon" | "later";

/** How urgent a due time is: overdue, due today, within 3 days, or later. */
export function dueState(dueAt: string | null, now: Date = new Date()): DueState {
  if (!dueAt) return "none";
  const at = Date.parse(dueAt);
  if (at < now.getTime()) return "overdue";
  const today = todayInBusinessTz(now);
  const day = todayInBusinessTz(new Date(at));
  if (day === today) return "today";
  return daysBetween(today, day) <= 3 ? "soon" : "later";
}

/**
 * Who owes the next move on an assigned task, from its last human message:
 * if the assignee wrote last (often a question), the giver; otherwise the assignee.
 */
export function waitingOn(
  task: {
    kind: TaskKind;
    status: TaskStatus;
    assignee_id: string;
    created_by: string | null;
  },
  lastAuthorId: string | null,
): "assignee" | "giver" | null {
  if (task.kind !== "assigned" || task.status === "done") return null;
  if (lastAuthorId && lastAuthorId === task.assignee_id && task.created_by) return "giver";
  return "assignee";
}

type DigestMessage = {
  kind: string;
  author_name: string;
  body: string;
  author_id: string | null;
};

/**
 * A summary without AI (used when AI is off or fails): where it stands, the
 * last question still open, and the latest word from each side.
 */
export function threadDigest(
  task: {
    title: string;
    status: TaskStatus;
    assignee_name: string | null;
    created_by_name: string;
    due_at: string | null;
    assignee_id: string;
  },
  messages: readonly DigestMessage[],
): string {
  const said = messages.filter((m) => m.kind === "message");
  const overdue = task.status !== "done" && dueState(task.due_at) === "overdue";
  const lines = [
    `- ${TASK_STATUS_LABELS[task.status]}${task.assignee_name ? `, with ${task.assignee_name}` : ""}${overdue ? " (overdue)" : ""}.`,
  ];
  const lastQuestion = [...said].reverse().find((m) => m.body.trim().endsWith("?"));
  if (lastQuestion) {
    const answered =
      said.indexOf(lastQuestion) < said.length - 1 &&
      said.slice(said.indexOf(lastQuestion) + 1).some((m) => m.author_id !== lastQuestion.author_id);
    lines.push(
      `- ${answered ? "Last question (answered)" : "Open question"} from ${lastQuestion.author_name}: "${lastQuestion.body.trim().slice(0, 160)}"`,
    );
  }
  const last = said.at(-1);
  if (last) lines.push(`- Latest, ${last.author_name}: "${last.body.trim().slice(0, 160)}"`);
  lines.push(`- ${said.length} message${said.length === 1 ? "" : "s"} in the thread.`);
  return lines.join("\n");
}
