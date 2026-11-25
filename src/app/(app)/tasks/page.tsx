import type { Metadata } from "next";
import Link from "next/link";
import { LayoutTemplate, Link2, MessageSquare, UserRound } from "lucide-react";

import { PageHeader } from "@/components/app-shell/page-header";
import { DueChip, PriorityBadge, RaisedBadge, TagChips, UnreadDot } from "@/components/work-tasks/task-badges";
import { TaskCopilot } from "@/components/work-tasks/task-copilot";
import { TaskEditor } from "@/components/work-tasks/task-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { isAdmin, requireSession } from "@/lib/auth";
import { cn } from "@/lib/utils";
import {
  isTaskPriority,
  isTaskStatus,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  waitingOn,
  type TaskStatus,
} from "@/lib/work-tasks";
import { listTasks, listTaskTemplates, taskRecipients, taskTags, type TaskFilters, type TaskListItem } from "@/server/data/work-tasks";

export const metadata: Metadata = { title: "Task Grid" };

const VIEWS = [
  { value: "all", label: "All" },
  { value: "mine", label: "Assigned to me" },
  { value: "given", label: "Given by me" },
  { value: "personal", label: "My to-dos" },
  { value: "raised", label: "Raised to admins" },
] as const;

const DUE = [
  { value: "", label: "Any due date" },
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Due today" },
  { value: "week", label: "Due this week" },
  { value: "none", label: "No deadline" },
] as const;

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, key: string) => {
  const v = q[key];
  return (Array.isArray(v) ? v[0] : v)?.trim() || "";
};

function parseFilters(q: Query): TaskFilters & { view: NonNullable<TaskFilters["view"]> } {
  const view = VIEWS.some((v) => v.value === one(q, "view")) ? (one(q, "view") as TaskFilters["view"] & string) : "all";
  const status = one(q, "status");
  const priority = one(q, "priority");
  const due = one(q, "due");
  const lead = Number(one(q, "lead"));
  return {
    view,
    status: isTaskStatus(status) ? status : null,
    priority: isTaskPriority(priority) ? priority : null,
    assignee: one(q, "assignee") || null,
    tag: one(q, "tag") || null,
    lead: Number.isInteger(lead) && lead > 0 ? lead : null,
    due: DUE.some((d) => d.value && d.value === due) ? (due as TaskFilters["due"]) : null,
    q: one(q, "q") || null,
  };
}

function TaskCard({ task, currentUserId, admin }: { task: TaskListItem; currentUserId: string; admin: boolean }) {
  const waiting = waitingOn(task, task.last_message?.author_id ?? null);
  const onYou =
    (waiting === "giver" && task.created_by === currentUserId) || (waiting === "assignee" && task.assignee_id === currentUserId && task.kind === "assigned");
  return (
    <li>
      <Link
        href={`/tasks/${task.id}`}
        className={cn(
          "lift block rounded-xl border bg-card p-3 text-sm transition-colors hover:border-primary/40",
          task.unread > 0 && "border-primary/40 ring-1 ring-primary/20",
          task.priority === "P1" && task.status !== "done" && "border-l-4 border-l-red-500",
        )}
      >
        <div className="mb-1.5 flex items-start justify-between gap-2">
          <span className={cn("font-medium", task.status === "done" && "text-muted-foreground line-through")}>{task.title}</span>
          <UnreadDot count={task.unread} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityBadge priority={task.priority} short />
          <DueChip dueAt={task.due_at} done={task.status === "done"} />
          {task.kind === "personal" ? (
            <span className="text-[11px] text-muted-foreground">Private</span>
          ) : null}
          {task.raised ? <RaisedBadge /> : null}
        </div>
        <TagChips tags={task.tags} className="mt-1.5" />
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {task.kind === "assigned" ? (
            <span className="inline-flex items-center gap-1">
              <UserRound className="size-3" />
              {task.assignee_id === currentUserId
                ? `${task.raised ? "Raised by" : "From"} ${task.created_by_name || "an admin"}`
                : `${task.assignee_name ?? "Someone"}${admin && task.created_by !== currentUserId ? ` · by ${task.created_by_name}` : ""}`}
            </span>
          ) : null}
          {task.lead_name ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <Link2 className="size-3" />
              <span className="truncate">{task.lead_name}</span>
            </span>
          ) : null}
          {task.message_count ? (
            <span className="inline-flex items-center gap-1">
              <MessageSquare className="size-3" />
              {task.message_count}
            </span>
          ) : null}
        </div>
        {onYou ? <p className="mt-2 text-[11px] font-medium text-primary">Waiting on you</p> : null}
        {task.last_message ? (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            <span className="font-medium">{task.last_message.author_id === currentUserId ? "You" : task.last_message.author_name}:</span> {task.last_message.body}
          </p>
        ) : null}
      </Link>
    </li>
  );
}

const COLUMN_TONE: Record<TaskStatus, string> = {
  todo: "bg-slate-400",
  in_progress: "bg-sky-500",
  blocked: "bg-red-500",
  done: "bg-emerald-500",
};

export default async function TasksPage({ searchParams }: PageProps<"/tasks">) {
  const { ctx, actor } = await requireSession();
  const admin = isAdmin(actor);
  const query = await searchParams;
  const filters = parseFilters(query);
  const [tasks, tags, recipients, templates] = await Promise.all([
    listTasks(ctx, actor, filters),
    taskTags(ctx, actor),
    taskRecipients(ctx, actor),
    listTaskTemplates(ctx, actor),
  ]);
  // Agents with no active admin to raise to just keep private to-dos.
  const editorMembers = recipients.length > 1 ? recipients : undefined;
  const members = admin ? recipients : undefined;
  const columns: readonly TaskStatus[] = filters.status && filters.status !== "open" ? [filters.status] : TASK_STATUSES;
  const href = (view: string) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (k !== "view" && typeof v === "string" && v) params.set(k, v);
    if (view !== "all") params.set("view", view);
    const s = params.toString();
    return s ? `/tasks?${s}` : "/tasks";
  };
  const unread = tasks.reduce((n, t) => n + t.unread, 0);

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Task Grid"
        description={
          admin
            ? "Give work to the team and talk it through on each task. Your own to-dos stay private."
            : "Tasks from your admins, your own to-dos, and anything you raise to an admin. Ask questions right on the task."
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <TaskCopilot admin={admin} />
            <Button asChild variant="outline">
              <Link href="/tasks/templates">
                <LayoutTemplate /> Templates
              </Link>
            </Button>
            <TaskEditor members={editorMembers} admin={admin} currentUserId={actor.id} templates={templates} />
          </div>
        }
      />

      <nav className="mb-4 flex flex-wrap gap-1.5" aria-label="Task views">
        {VIEWS.map((v) => (
          <Link
            key={v.value}
            href={href(v.value)}
            className={cn(
              "rounded-full border px-3 py-1 text-sm transition-colors",
              filters.view === v.value ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted",
            )}
          >
            {v.label}
          </Link>
        ))}
        {unread ? <span className="ml-auto self-center text-sm text-primary">{unread} unread message{unread === 1 ? "" : "s"}</span> : null}
      </nav>

      <form method="get" className="surface mb-5 grid grid-cols-2 gap-2 p-3 md:grid-cols-4 xl:grid-cols-7">
        {filters.view !== "all" ? <input type="hidden" name="view" value={filters.view} /> : null}
        <Input name="q" defaultValue={filters.q ?? ""} placeholder="Search tasks" aria-label="Search tasks" className="col-span-2 md:col-span-1 xl:col-span-2" />
        <NativeSelect name="status" defaultValue={filters.status ?? ""} aria-label="Status">
          <option value="">Any status</option>
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TASK_STATUS_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="priority" defaultValue={filters.priority ?? ""} aria-label="Priority">
          <option value="">Any priority</option>
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {TASK_PRIORITY_LABELS[p]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="due" defaultValue={filters.due ?? ""} aria-label="Due">
          {DUE.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="tag" defaultValue={filters.tag ?? ""} aria-label="Tag">
          <option value="">Any tag</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </NativeSelect>
        {members ? (
          <NativeSelect name="assignee" defaultValue={filters.assignee ?? ""} aria-label="Assignee">
            <option value="">Anyone</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name}
              </option>
            ))}
          </NativeSelect>
        ) : null}
        {filters.lead ? <input type="hidden" name="lead" value={filters.lead} /> : null}
        <div className="col-span-2 flex gap-2 md:col-span-1">
          <Button type="submit" variant="outline" className="flex-1">
            Filter
          </Button>
          <Button asChild variant="ghost">
            <Link href={filters.view === "all" ? "/tasks" : `/tasks?view=${filters.view}`}>Clear</Link>
          </Button>
        </div>
      </form>

      <div className={cn("grid grid-cols-1 gap-4", columns.length > 1 && "md:grid-cols-2 xl:grid-cols-4")}>
        {columns.map((status) => {
          const items = tasks.filter((t) => t.status === status);
          return (
            <section key={status} className="min-w-0 rounded-2xl bg-muted/40 p-3">
              <h2 className="mb-3 flex items-center gap-2 px-1 text-sm font-medium">
                <span className={cn("size-2 rounded-full", COLUMN_TONE[status])} />
                {TASK_STATUS_LABELS[status]}
                <span className="font-mono text-xs text-muted-foreground tabular-nums">{items.length}</span>
              </h2>
              {items.length ? (
                <ul className="stagger space-y-2">
                  {items.map((task) => (
                    <TaskCard key={task.id} task={task} currentUserId={actor.id} admin={admin} />
                  ))}
                </ul>
              ) : (
                <p className="px-1 py-6 text-center text-xs text-muted-foreground">Nothing here.</p>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
