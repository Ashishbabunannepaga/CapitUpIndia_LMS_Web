import "server-only";

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { BatchItem } from "drizzle-orm/batch";

import { addDays, startOfBusinessDay, todayInBusinessTz } from "@/lib/dates";
import {
  isTaskPriority,
  isTaskStatus,
  parseTags,
  tagsFromLead,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/work-tasks";

import { leads, notifications, profiles, workTaskMessages, workTaskReads, workTasks, workTaskTags } from "../db/schema";
import { isAdmin, type Actor } from "./actor";
import { auditInsert } from "./audit";
import type { DataContext } from "./context";
import { AccessDeniedError, InvalidInputError } from "./errors";

// Task Grid: work items with a conversation thread.
//
// Who sees what (enforced here, never in the browser):
//   * A personal task is its owner's alone. Not even admins see it.
//   * An assigned task is seen by its assignee, the person who gave it, and
//     every admin. Only admins (and agents for themselves) create tasks, so an
//     agent can never put work on someone else.
//   * The giver and admins edit an assigned task; its assignee moves its
//     status and talks in the thread. Anyone who sees a task can write in it.

export type WorkTask = typeof workTasks.$inferSelect;
export type TaskMessage = typeof workTaskMessages.$inferSelect;

export type TaskListItem = WorkTask & {
  assignee_name: string | null;
  lead_name: string | null;
  tags: string[];
  /** Messages from others the caller has not read. */
  unread: number;
  message_count: number;
  /** The newest message someone wrote (not a system line). */
  last_message: {
    body: string;
    author_id: string | null;
    author_name: string;
    created_at: string;
  } | null;
};

const NUDGE_COOLDOWN_MS = 30 * 60_000;
const LIST_LIMIT = 500;
export const MESSAGE_MAX = 4000;

const assignee = alias(profiles, "assignee");

/** Tasks the caller may see (see the rules at the top). */
function visibleTo(actor: Actor): SQL {
  return or(
    eq(workTasks.assignee_id, actor.id),
    and(eq(workTasks.kind, "assigned"), isAdmin(actor) ? sql`1` : eq(workTasks.created_by, actor.id)),
  )!;
}

function canEdit(actor: Actor, task: WorkTask): boolean {
  if (task.kind === "personal") return task.assignee_id === actor.id;
  return isAdmin(actor) || task.created_by === actor.id;
}

function canSetStatus(actor: Actor, task: WorkTask): boolean {
  return task.assignee_id === actor.id || canEdit(actor, task);
}

/** What the caller may do with a task, for the screens to show the right buttons. */
export function taskPermissions(actor: Actor, task: WorkTask) {
  const edit = canEdit(actor, task);
  return {
    edit,
    status: canSetStatus(actor, task),
    nudge: task.kind === "assigned" && edit && task.assignee_id !== actor.id && task.status !== "done",
    delete: edit,
    reassign: edit && isAdmin(actor),
  };
}

async function findVisible(ctx: DataContext, actor: Actor, id: number): Promise<WorkTask> {
  const task = await ctx.db.query.workTasks.findFirst({
    where: and(eq(workTasks.id, id), visibleTo(actor)),
  });
  if (!task) throw new InvalidInputError("That task no longer exists or isn't yours.");
  return task;
}

const unreadCount = (actor: Actor) => sql<number>`(
  select count(*) from ${workTaskMessages} m
  where m.task_id = ${workTasks.id} and m.kind = 'message' and coalesce(m.author_id, '') <> ${actor.id}
    and m.id > coalesce((select r.last_read_message_id from ${workTaskReads} r where r.task_id = ${workTasks.id} and r.user_id = ${actor.id}), 0)
)`;
const messageCount = sql<number>`(select count(*) from ${workTaskMessages} m where m.task_id = ${workTasks.id} and m.kind = 'message')`;
const lastMessageJson = sql<string | null>`(
  select json_object('body', m.body, 'author_id', m.author_id, 'author_name', m.author_name, 'created_at', m.created_at)
  from ${workTaskMessages} m where m.task_id = ${workTasks.id} and m.kind = 'message' order by m.id desc limit 1
)`;

function listSelect(ctx: DataContext, actor: Actor) {
  return ctx.db
    .select({
      task: workTasks,
      assignee_name: assignee.full_name,
      lead_name: leads.client_name,
      unread: unreadCount(actor),
      message_count: messageCount,
      last_message: lastMessageJson,
    })
    .from(workTasks)
    .leftJoin(assignee, eq(assignee.id, workTasks.assignee_id))
    .leftJoin(leads, eq(leads.id, workTasks.lead_id));
}

type ListRow = Awaited<ReturnType<ReturnType<typeof listSelect>["where"]>>[number];

async function withTags(ctx: DataContext, rows: ListRow[]): Promise<TaskListItem[]> {
  const ids = rows.map((r) => r.task.id);
  const tags = ids.length
    ? await ctx.db.select().from(workTaskTags).where(inArray(workTaskTags.task_id, ids)).orderBy(asc(workTaskTags.tag))
    : [];
  const byTask = new Map<number, string[]>();
  for (const t of tags) byTask.set(t.task_id, [...(byTask.get(t.task_id) ?? []), t.tag]);
  return rows.map((r) => ({
    ...r.task,
    assignee_name: r.assignee_name,
    lead_name: r.lead_name,
    tags: byTask.get(r.task.id) ?? [],
    unread: Number(r.unread) || 0,
    message_count: Number(r.message_count) || 0,
    last_message: r.last_message ? (JSON.parse(r.last_message) as TaskListItem["last_message"]) : null,
  }));
}

export type TaskFilters = {
  /** mine: assigned to the caller; given: tasks the caller gave others; personal: the caller's own to-dos; all: everything visible. */
  view?: "all" | "mine" | "given" | "personal";
  status?: TaskStatus | "open" | null;
  priority?: TaskPriority | null;
  assignee?: string | null;
  tag?: string | null;
  lead?: number | null;
  due?: "overdue" | "today" | "week" | "none" | null;
  q?: string | null;
};

export async function listTasks(
  ctx: DataContext,
  actor: Actor,
  filters: TaskFilters = {},
  now: Date = new Date(),
): Promise<TaskListItem[]> {
  const conditions: (SQL | undefined)[] = [visibleTo(actor)];
  if (filters.view === "mine") conditions.push(eq(workTasks.assignee_id, actor.id));
  if (filters.view === "given")
    conditions.push(eq(workTasks.created_by, actor.id), eq(workTasks.kind, "assigned"), ne(workTasks.assignee_id, actor.id));
  if (filters.view === "personal") conditions.push(eq(workTasks.kind, "personal"), eq(workTasks.assignee_id, actor.id));
  if (filters.status === "open") conditions.push(ne(workTasks.status, "done"));
  else if (filters.status && isTaskStatus(filters.status)) conditions.push(eq(workTasks.status, filters.status));
  if (filters.priority && isTaskPriority(filters.priority)) conditions.push(eq(workTasks.priority, filters.priority));
  if (filters.assignee) conditions.push(eq(workTasks.assignee_id, filters.assignee));
  if (filters.lead) conditions.push(eq(workTasks.lead_id, filters.lead));
  if (filters.tag) {
    conditions.push(sql`exists (select 1 from ${workTaskTags} g where g.task_id = ${workTasks.id} and g.tag = ${filters.tag})`);
  }
  if (filters.q?.trim()) {
    const term = `%${filters.q
      .trim()
      .slice(0, 100)
      .replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(sql`(${workTasks.title} like ${term} escape '\\' or ${workTasks.description} like ${term} escape '\\')`);
  }
  if (filters.due) {
    const today = todayInBusinessTz(now);
    const open = ne(workTasks.status, "done");
    if (filters.due === "none") conditions.push(isNull(workTasks.due_at));
    if (filters.due === "overdue") conditions.push(open, lt(workTasks.due_at, now.toISOString()));
    if (filters.due === "today") {
      conditions.push(
        open,
        gte(workTasks.due_at, startOfBusinessDay(today)),
        lt(workTasks.due_at, startOfBusinessDay(addDays(today, 1))),
      );
    }
    if (filters.due === "week")
      conditions.push(open, isNotNull(workTasks.due_at), lt(workTasks.due_at, startOfBusinessDay(addDays(today, 8))));
  }
  const rows = await listSelect(ctx, actor)
    .where(and(...conditions))
    .orderBy(
      sql`case ${workTasks.status} when 'done' then 1 else 0 end`,
      asc(workTasks.priority),
      sql`${workTasks.due_at} is null`,
      asc(workTasks.due_at),
      desc(workTasks.last_activity_at),
    )
    .limit(LIST_LIMIT);
  return withTags(ctx, rows);
}

export type TaskThread = {
  task: TaskListItem;
  messages: TaskMessage[];
  can: ReturnType<typeof taskPermissions>;
  giver_name: string | null;
};

/** One task with its whole thread, oldest message first. */
export async function getTaskThread(ctx: DataContext, actor: Actor, id: number): Promise<TaskThread | null> {
  const [rows, messages] = await ctx.db.batch([
    listSelect(ctx, actor)
      .where(and(eq(workTasks.id, id), visibleTo(actor)))
      .limit(1),
    ctx.db.select().from(workTaskMessages).where(eq(workTaskMessages.task_id, id)).orderBy(asc(workTaskMessages.id)).limit(1000),
  ]);
  if (!rows.length) return null;
  const [task] = await withTags(ctx, rows);
  return {
    task,
    messages,
    can: taskPermissions(actor, task),
    giver_name: task.created_by_name || null,
  };
}

export type NewWorkTask = {
  title: string;
  description?: string;
  priority?: string;
  due_at?: string | null;
  assignee_id?: string | null;
  lead_id?: number | null;
  tags?: string | readonly string[];
  /** Add the linked lead's product, line and renewal tags (default true). */
  autoTag?: boolean;
};

async function checkLead(ctx: DataContext, actor: Actor, leadId: number | null | undefined) {
  if (!leadId) return null;
  const lead = await ctx.db.query.leads.findFirst({
    where: and(eq(leads.id, leadId), isAdmin(actor) ? undefined : eq(leads.assigned_agent_id, actor.id)),
  });
  if (!lead) throw new InvalidInputError("That lead no longer exists or isn't yours.");
  return lead;
}

async function checkAssignee(ctx: DataContext, actor: Actor, id: string): Promise<Actor> {
  if (id === actor.id) return actor;
  if (!isAdmin(actor)) throw new AccessDeniedError("Only admins can give tasks to other people.");
  const member = await ctx.db.query.profiles.findFirst({
    where: eq(profiles.id, id),
  });
  if (!member?.is_active) throw new InvalidInputError("Pick an active team member.");
  return member;
}

function checkText(input: { title?: string; description?: string; priority?: string; due_at?: string | null }) {
  const title = input.title?.trim() ?? "";
  if (!title) throw new InvalidInputError("Give the task a title.");
  if (title.length > 200) throw new InvalidInputError("Keep the title under 200 characters.");
  const description = (input.description ?? "").trim();
  if (description.length > 5000) throw new InvalidInputError("Keep the details under 5,000 characters.");
  const priority = input.priority ?? "P2";
  if (!isTaskPriority(priority)) throw new InvalidInputError("Pick P1, P2 or P3.");
  let due_at: string | null = null;
  if (input.due_at) {
    if (Number.isNaN(Date.parse(input.due_at))) throw new InvalidInputError("Pick a valid due date.");
    due_at = new Date(input.due_at).toISOString();
  }
  return { title, description, priority, due_at };
}

function taskNotification(userId: string, taskId: number, leadId: number | null, title: string, body: string) {
  return {
    user_id: userId,
    kind: "other" as const,
    title: title.slice(0, 300),
    body: body.slice(0, 2000),
    task_id: taskId,
    lead_id: leadId,
  };
}

function dueText(dueAt: string | null): string {
  if (!dueAt) return "No deadline";
  return `Due ${new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(dueAt))}`;
}

/** A task for the caller (personal) or, for admins, given to someone (assigned). */
export async function createWorkTask(ctx: DataContext, actor: Actor, input: NewWorkTask): Promise<WorkTask> {
  const fields = checkText(input);
  const member = await checkAssignee(ctx, actor, input.assignee_id || actor.id);
  const lead = await checkLead(ctx, actor, input.lead_id);
  const tags = parseTags([...parseTags(input.tags ?? ""), ...(lead && input.autoTag !== false ? tagsFromLead(lead) : [])]);
  const kind = member.id === actor.id ? "personal" : "assigned";

  const [task] = await ctx.db
    .insert(workTasks)
    .values({
      ...fields,
      kind,
      assignee_id: member.id,
      created_by: actor.id,
      created_by_name: actor.full_name,
      lead_id: lead?.id ?? null,
    })
    .returning();

  const writes: BatchItem<"sqlite">[] = [
    auditInsert(ctx, actor, "work_tasks", task.id, "INSERT", null, {
      title: task.title,
      kind,
      assignee_id: member.id,
      priority: task.priority,
      due_at: task.due_at,
      lead_id: task.lead_id,
    }),
  ];
  if (tags.length) writes.push(ctx.db.insert(workTaskTags).values(tags.map((tag) => ({ task_id: task.id, tag }))));
  if (kind === "assigned") {
    writes.push(
      ctx.db.insert(workTaskMessages).values({
        task_id: task.id,
        author_id: actor.id,
        author_name: actor.full_name,
        kind: "system",
        body: `${actor.full_name} assigned this to ${member.full_name} (${TASK_PRIORITY_LABELS[task.priority]}).`,
      }),
      ctx.db
        .insert(notifications)
        .values(
          taskNotification(
            member.id,
            task.id,
            task.lead_id,
            `New task from ${actor.full_name}: ${task.title}`,
            `${task.priority} · ${dueText(task.due_at)}`,
          ),
        ),
    );
  }
  await ctx.db.batch(writes as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return task;
}

export type WorkTaskChanges = Partial<Omit<NewWorkTask, "autoTag">>;

/** Edits a task: the giver or an admin for assigned tasks, the owner for personal ones. */
export async function updateWorkTask(ctx: DataContext, actor: Actor, id: number, changes: WorkTaskChanges): Promise<WorkTask> {
  const task = await findVisible(ctx, actor, id);
  if (!canEdit(actor, task)) throw new AccessDeniedError("Only the person who gave this task (or an admin) can change it.");
  const fields = checkText({
    title: changes.title ?? task.title,
    description: changes.description ?? task.description,
    priority: changes.priority ?? task.priority,
    due_at: changes.due_at === undefined ? task.due_at : changes.due_at,
  });
  const lead = changes.lead_id === undefined ? undefined : await checkLead(ctx, actor, changes.lead_id);
  let member: Actor | null = null;
  if (changes.assignee_id && changes.assignee_id !== task.assignee_id) {
    if (!isAdmin(actor)) throw new AccessDeniedError("Only admins can hand a task to someone else.");
    member = await checkAssignee(ctx, actor, changes.assignee_id);
  }
  const values = {
    ...fields,
    ...(lead !== undefined ? { lead_id: lead?.id ?? null } : {}),
    ...(member
      ? {
          assignee_id: member.id,
          kind: member.id === actor.id && task.kind === "personal" ? ("personal" as const) : ("assigned" as const),
          seen_at: null,
        }
      : {}),
    updated_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
  };
  const before = {
    title: task.title,
    description: task.description,
    priority: task.priority,
    due_at: task.due_at,
    lead_id: task.lead_id,
    assignee_id: task.assignee_id,
  };
  const after = { ...before, ...values };
  delete (after as Record<string, unknown>).updated_at;
  delete (after as Record<string, unknown>).last_activity_at;
  delete (after as Record<string, unknown>).seen_at;
  delete (after as Record<string, unknown>).kind;

  const notes: string[] = [];
  if (fields.priority !== task.priority) notes.push(`priority to ${TASK_PRIORITY_LABELS[fields.priority]}`);
  if (fields.due_at !== task.due_at)
    notes.push(fields.due_at ? `due date to ${dueText(fields.due_at).replace(/^Due /, "")}` : "no deadline");

  const writes: BatchItem<"sqlite">[] = [
    ctx.db.update(workTasks).set(values).where(eq(workTasks.id, id)),
    auditInsert(ctx, actor, "work_tasks", id, "UPDATE", before, after),
  ];
  if (changes.tags !== undefined) {
    const tags = parseTags(changes.tags);
    writes.push(ctx.db.delete(workTaskTags).where(eq(workTaskTags.task_id, id)));
    if (tags.length) writes.push(ctx.db.insert(workTaskTags).values(tags.map((tag) => ({ task_id: id, tag }))));
  }
  if (member) {
    notes.push(`handed it to ${member.full_name}`);
    if (member.id !== actor.id) {
      writes.push(
        ctx.db
          .insert(notifications)
          .values(
            taskNotification(
              member.id,
              id,
              values.lead_id ?? task.lead_id,
              `Task handed to you by ${actor.full_name}: ${fields.title}`,
              `${fields.priority} · ${dueText(fields.due_at)}`,
            ),
          ),
      );
    }
  }
  if (notes.length && task.kind === "assigned") {
    writes.push(
      ctx.db.insert(workTaskMessages).values({
        task_id: id,
        author_id: actor.id,
        author_name: actor.full_name,
        kind: "system",
        body: `${actor.full_name} changed ${notes.join(", ")}.`,
      }),
    );
  }
  await ctx.db.batch(writes as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return { ...task, ...values };
}

/** Moves a task through To do, In progress, Blocked and Done. A note (say, why it is blocked) goes into the thread. */
export async function setWorkTaskStatus(
  ctx: DataContext,
  actor: Actor,
  id: number,
  status: string,
  note?: string,
): Promise<void> {
  if (!isTaskStatus(status)) throw new InvalidInputError("Pick a status.");
  const task = await findVisible(ctx, actor, id);
  if (!canSetStatus(actor, task)) throw new AccessDeniedError("You can't change this task's status.");
  if (task.status === status) return;
  const text = (note ?? "").trim();
  if (text.length > MESSAGE_MAX) throw new InvalidInputError("Keep the note under 4,000 characters.");
  const now = new Date().toISOString();
  const writes: BatchItem<"sqlite">[] = [
    ctx.db
      .update(workTasks)
      .set({
        status,
        completed_at: status === "done" ? now : null,
        updated_at: now,
        last_activity_at: now,
      })
      .where(eq(workTasks.id, id)),
    auditInsert(
      ctx,
      actor,
      "work_tasks",
      id,
      "UPDATE",
      { title: task.title, status: task.status },
      { title: task.title, status },
    ),
  ];
  if (task.kind === "assigned") {
    writes.push(
      ctx.db.insert(workTaskMessages).values({
        task_id: id,
        author_id: actor.id,
        author_name: actor.full_name,
        kind: "system",
        body: `${actor.full_name} moved this to ${TASK_STATUS_LABELS[status]}.`,
      }),
    );
    if (text)
      writes.push(
        ctx.db.insert(workTaskMessages).values({
          task_id: id,
          author_id: actor.id,
          author_name: actor.full_name,
          body: text,
        }),
      );
    // The assignee finishing or getting stuck is news for the person who gave it.
    if (
      actor.id === task.assignee_id &&
      task.created_by &&
      task.created_by !== actor.id &&
      (status === "done" || status === "blocked")
    ) {
      writes.push(
        ctx.db
          .insert(notifications)
          .values(
            taskNotification(
              task.created_by,
              id,
              task.lead_id,
              `${actor.full_name} ${status === "done" ? "finished" : "is blocked on"}: ${task.title}`,
              text || TASK_STATUS_LABELS[status],
            ),
          ),
      );
    }
  }
  await ctx.db.batch(writes as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

/**
 * Adds a message to a task's thread. The other side of an assigned task gets
 * one bell notification until they read it (not one per message).
 */
export async function postTaskMessage(
  ctx: DataContext,
  actor: Actor,
  id: number,
  input: { body: string; via?: "text" | "voice" },
): Promise<TaskMessage> {
  const body = input.body.trim();
  if (!body) throw new InvalidInputError("Write a message first.");
  if (body.length > MESSAGE_MAX) throw new InvalidInputError("Keep the message under 4,000 characters.");
  const task = await findVisible(ctx, actor, id);
  const via = input.via === "voice" ? "voice" : "text";
  const now = new Date().toISOString();

  const [message] = await ctx.db
    .insert(workTaskMessages)
    .values({
      task_id: id,
      author_id: actor.id,
      author_name: actor.full_name,
      body,
      via,
    })
    .returning();

  const writes: BatchItem<"sqlite">[] = [
    ctx.db.update(workTasks).set({ last_activity_at: now }).where(eq(workTasks.id, id)),
    readUpsert(ctx, id, actor.id, message.id),
  ];
  if (task.kind === "assigned") {
    const recipients = [task.assignee_id, task.created_by].filter((u): u is string => !!u && u !== actor.id);
    if (recipients.length) {
      const waiting = await ctx.db
        .select({ user_id: notifications.user_id })
        .from(notifications)
        .where(and(eq(notifications.task_id, id), inArray(notifications.user_id, recipients), isNull(notifications.read_at)));
      const already = new Set(waiting.map((w) => w.user_id));
      const fresh = recipients.filter((u) => !already.has(u));
      if (fresh.length) {
        writes.push(
          ctx.db
            .insert(notifications)
            .values(
              fresh.map((u) =>
                taskNotification(u, id, task.lead_id, `${actor.full_name} replied on: ${task.title}`, body.slice(0, 200)),
              ),
            ),
        );
      }
    }
  }
  await ctx.db.batch(writes as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return message;
}

function readUpsert(ctx: DataContext, taskId: number, userId: string, messageId: number) {
  return ctx.db
    .insert(workTaskReads)
    .values({
      task_id: taskId,
      user_id: userId,
      last_read_message_id: messageId,
    })
    .onConflictDoUpdate({
      target: [workTaskReads.task_id, workTaskReads.user_id],
      set: {
        last_read_message_id: sql`max(${workTaskReads.last_read_message_id}, ${messageId})`,
        read_at: new Date().toISOString(),
      },
    });
}

/** The caller opened the task: its thread counts as read, its bell items too, and the giver sees "Seen". */
export async function markTaskRead(ctx: DataContext, actor: Actor, id: number): Promise<void> {
  const task = await findVisible(ctx, actor, id);
  const [last] = await ctx.db
    .select({ id: workTaskMessages.id })
    .from(workTaskMessages)
    .where(eq(workTaskMessages.task_id, id))
    .orderBy(desc(workTaskMessages.id))
    .limit(1);
  const now = new Date().toISOString();
  const writes: BatchItem<"sqlite">[] = [
    readUpsert(ctx, id, actor.id, last?.id ?? 0),
    ctx.db
      .update(notifications)
      .set({ read_at: now })
      .where(and(eq(notifications.user_id, actor.id), eq(notifications.task_id, id), isNull(notifications.read_at))),
  ];
  if (task.kind === "assigned" && task.assignee_id === actor.id && !task.seen_at) {
    writes.push(ctx.db.update(workTasks).set({ seen_at: now }).where(eq(workTasks.id, id)));
  }
  await ctx.db.batch(writes as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

/** The giver (or an admin) pokes the assignee: a bell notification and a line in the thread. At most every 30 minutes. */
export async function nudgeWorkTask(ctx: DataContext, actor: Actor, id: number, now: Date = new Date()): Promise<void> {
  const task = await findVisible(ctx, actor, id);
  if (!taskPermissions(actor, task).nudge) throw new AccessDeniedError("You can't nudge on this task.");
  if (task.nudged_at && now.getTime() - Date.parse(task.nudged_at) < NUDGE_COOLDOWN_MS) {
    throw new InvalidInputError("Already nudged in the last 30 minutes.");
  }
  const at = now.toISOString();
  await ctx.db.batch([
    ctx.db.update(workTasks).set({ nudged_at: at, last_activity_at: at }).where(eq(workTasks.id, id)),
    ctx.db.insert(workTaskMessages).values({
      task_id: id,
      author_id: actor.id,
      author_name: actor.full_name,
      kind: "system",
      body: `${actor.full_name} sent a nudge.`,
    }),
    ctx.db
      .insert(notifications)
      .values(
        taskNotification(
          task.assignee_id,
          id,
          task.lead_id,
          `Nudge from ${actor.full_name}: ${task.title}`,
          `${task.priority} · ${dueText(task.due_at)}`,
        ),
      ),
  ]);
}

export async function deleteWorkTask(ctx: DataContext, actor: Actor, id: number): Promise<void> {
  const task = await findVisible(ctx, actor, id);
  if (!canEdit(actor, task)) throw new AccessDeniedError("Only the person who gave this task (or an admin) can delete it.");
  await ctx.db.batch([
    ctx.db.delete(workTasks).where(eq(workTasks.id, id)),
    auditInsert(
      ctx,
      actor,
      "work_tasks",
      id,
      "DELETE",
      {
        title: task.title,
        kind: task.kind,
        assignee_id: task.assignee_id,
        status: task.status,
      },
      null,
    ),
  ]);
}

export type PinnedTask = TaskListItem & {
  recent: TaskMessage[];
  role: "incoming" | "given";
};

/**
 * For the My Day header: open tasks someone gave the caller (urgent first),
 * and tasks the caller gave that need them (an unread reply, or blocked),
 * each with its last three thread lines.
 */
export async function pinnedTasks(ctx: DataContext, actor: Actor): Promise<PinnedTask[]> {
  const rows = await listSelect(ctx, actor)
    .where(
      and(
        eq(workTasks.kind, "assigned"),
        ne(workTasks.status, "done"),
        or(
          and(eq(workTasks.assignee_id, actor.id), ne(sql`coalesce(${workTasks.created_by}, '')`, actor.id)),
          and(eq(workTasks.created_by, actor.id), or(eq(workTasks.status, "blocked"), sql`${unreadCount(actor)} > 0`)),
        ),
      ),
    )
    .orderBy(asc(workTasks.priority), sql`${workTasks.due_at} is null`, asc(workTasks.due_at), desc(workTasks.last_activity_at))
    .limit(12);
  const items = await withTags(ctx, rows);
  if (!items.length) return [];
  const recent = await ctx.db.all<TaskMessage>(sql`
    select id, task_id, author_id, author_name, kind, via, body, created_at from (
      select m.*, row_number() over (partition by m.task_id order by m.id desc) as rn
      from ${workTaskMessages} m where m.task_id in (${sql.join(
        items.map((i) => sql`${i.id}`),
        sql`, `,
      )})
    ) where rn <= 3 order by id
  `);
  return items.map((item) => ({
    ...item,
    role: item.assignee_id === actor.id ? "incoming" : "given",
    recent: recent.filter((m) => m.task_id === item.id),
  }));
}

/** Open tasks counted by status, for the board header (same visibility as the list). */
export async function taskCounts(ctx: DataContext, actor: Actor) {
  const rows = await ctx.db
    .select({ status: workTasks.status, n: sql<number>`count(*)` })
    .from(workTasks)
    .where(visibleTo(actor))
    .groupBy(workTasks.status);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])) as Partial<Record<TaskStatus, number>>;
}

/** Distinct tags on tasks the caller can see, for the filter. */
export async function taskTags(ctx: DataContext, actor: Actor): Promise<string[]> {
  const rows = await ctx.db
    .selectDistinct({ tag: workTaskTags.tag })
    .from(workTaskTags)
    .innerJoin(workTasks, eq(workTasks.id, workTaskTags.task_id))
    .where(visibleTo(actor))
    .orderBy(asc(workTaskTags.tag))
    .limit(200);
  return rows.map((r) => r.tag);
}

/** The lead facts the task form uses to suggest a due date and tags. */
export async function leadTaskContext(ctx: DataContext, actor: Actor, leadId: number) {
  const lead = await checkLead(ctx, actor, leadId);
  if (!lead) return null;
  return {
    id: lead.id,
    client_name: lead.client_name,
    renewal_date: lead.renewal_date,
    tags: tagsFromLead(lead),
  };
}
