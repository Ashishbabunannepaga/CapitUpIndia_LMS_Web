import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Eye, Link2 } from "lucide-react";

import { ApprovalBadge, DueChip, PriorityBadge, RaisedBadge, TagChips, TaskStatusBadge } from "@/components/work-tasks/task-badges";
import { ApprovalPanel } from "@/components/work-tasks/task-approval";
import { TaskEditor } from "@/components/work-tasks/task-editor";
import { TemplateDialog } from "@/components/work-tasks/task-templates";
import {
  Composer,
  DeleteTaskButton,
  MarkRead,
  MessageList,
  NudgeButton,
  StatusButtons,
  SummaryButton,
} from "@/components/work-tasks/task-thread";
import { isAdmin, requireSession } from "@/lib/auth";
import { businessDateOf, formatDateTime, formatNoteTimestamp } from "@/lib/dates";
import { waitingOn } from "@/lib/work-tasks";
import { getTaskThread, taskRecipients } from "@/server/data/work-tasks";

export const metadata: Metadata = { title: "Task" };

const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

export default async function TaskPage({ params }: PageProps<"/tasks/[id]">) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const { ctx, actor } = await requireSession();
  const admin = isAdmin(actor);
  const [thread, recipients] = await Promise.all([getTaskThread(ctx, actor, id), taskRecipients(ctx, actor)]);
  if (!thread) notFound();
  const { task, messages, can } = thread;
  const members = recipients.length > 1 ? recipients : undefined;
  const lastHuman = [...messages].reverse().find((m) => m.kind === "message");
  const waiting = waitingOn(task, lastHuman?.author_id ?? null);
  const latest = messages.at(-1)?.id ?? 0;

  return (
    <div className="mx-auto max-w-6xl">
      <MarkRead taskId={task.id} latest={latest} />
      <Link href="/tasks" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary">
        <ArrowLeft className="size-4" /> Task Grid
      </Link>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <header className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <PriorityBadge priority={task.priority} />
              <TaskStatusBadge status={task.status} />
              <DueChip dueAt={task.due_at} done={task.status === "done"} />
              {task.kind === "personal" ? <span className="text-xs text-muted-foreground">Private to-do: only you see it</span> : null}
              {task.raised && !task.approval ? <RaisedBadge /> : null}
              <ApprovalBadge approval={task.approval} />
            </div>
            <h1 className="text-2xl leading-tight font-medium tracking-tight">{task.title}</h1>
            {task.description ? <p className="text-sm whitespace-pre-wrap text-muted-foreground">{task.description}</p> : null}
            <TagChips tags={task.tags} />
          </header>

          {waiting ? (
            <p className="rounded-md border bg-card px-3 py-2 text-sm">
              {waiting === "giver"
                ? task.created_by === actor.id
                  ? `${task.assignee_name ?? "The assignee"} is waiting on your reply.`
                  : `Waiting on ${task.created_by_name || "the admin"} to reply.`
                : task.assignee_id === actor.id
                  ? "Your move: update the status or reply."
                  : `Waiting on ${task.assignee_name ?? "the assignee"}.`}
            </p>
          ) : null}

          <section className="surface p-4 sm:p-5">
            <h2 className="mb-4 text-sm font-medium">{task.kind === "assigned" ? "Conversation" : "Notes"}</h2>
            <MessageList messages={messages} currentUserId={actor.id} />
            <div className="mt-5 border-t pt-4">
              <Composer taskId={task.id} placeholder={task.kind === "assigned" ? undefined : "Add a note to yourself…"} />
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          {task.approval === "pending" && actor.role === "ADMIN" ? (
            <ApprovalPanel taskId={task.id} askedBy={task.created_by_name || "The agent"} />
          ) : null}
          {task.approval && task.approval !== "pending" && task.approval_note ? (
            <section className="surface p-4 text-sm">
              <h2 className="mb-1 font-medium">{task.approval === "approved" ? "Approved" : "Rejected"}</h2>
              <p className="whitespace-pre-wrap text-muted-foreground">{task.approval_note}</p>
            </section>
          ) : null}
          {can.status ? (
            <section className="surface p-4">
              <h2 className="mb-2 text-sm font-medium">Status</h2>
              <StatusButtons taskId={task.id} status={task.status} />
            </section>
          ) : null}

          <section className="surface divide-y px-4 py-2">
            {task.kind === "assigned" ? (
              <>
                <Row label="Assigned to">{task.assignee_id === actor.id ? "You" : task.assignee_name}</Row>
                <Row label={task.raised ? "Raised by" : "Given by"}>{task.created_by === actor.id ? "You" : task.created_by_name || "—"}</Row>
                <Row label="Seen">
                  {task.seen_at ? (
                    <span className="inline-flex items-center gap-1">
                      <Eye className="size-3.5" /> {formatNoteTimestamp(task.seen_at)}
                    </span>
                  ) : (
                    "Not yet"
                  )}
                </Row>
              </>
            ) : null}
            <Row label="Lead">
              {task.lead_id ? (
                <Link href={`/leads/${task.lead_id}`} className="inline-flex items-center gap-1 hover:text-primary hover:underline">
                  <Link2 className="size-3.5" /> {task.lead_name}
                </Link>
              ) : (
                "—"
              )}
            </Row>
            <Row label="Created">{formatDateTime(task.created_at)}</Row>
            {task.completed_at ? <Row label="Done">{formatDateTime(task.completed_at)}</Row> : null}
          </section>

          <section className="surface space-y-3 p-4">
            <SummaryButton taskId={task.id} />
            {can.nudge && task.assignee_name ? <NudgeButton taskId={task.id} name={task.assignee_name} /> : null}
            <div className="flex flex-wrap items-center gap-2">
              {can.edit ? (
                <TaskEditor
                  trigger="icon"
                  members={can.reassign ? members : undefined}
                  admin={admin}
                  currentUserId={actor.id}
                  task={{
                    id: task.id,
                    title: task.title,
                    description: task.description,
                    priority: task.priority,
                    due_date: task.due_at ? businessDateOf(task.due_at) : "",
                    due_time: task.due_at ? timeFormat.format(new Date(task.due_at)) : "",
                    assignee_id: task.assignee_id,
                    tags: task.tags,
                    lead: task.lead_id && task.lead_name ? { id: task.lead_id, client_name: task.lead_name } : null,
                  }}
                />
              ) : null}
              <TemplateDialog
                admin={admin}
                trigger="save-from-task"
                draft={{
                  name: task.title.slice(0, 80),
                  title: task.title,
                  description: task.description,
                  priority: task.priority,
                  tags: task.tags.join(", "),
                  due_in_days: null,
                  shared: false,
                }}
              />
              {can.delete ? <DeleteTaskButton taskId={task.id} /> : null}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
