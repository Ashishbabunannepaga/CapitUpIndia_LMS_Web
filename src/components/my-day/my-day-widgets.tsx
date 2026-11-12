"use client";

import { useOptimistic, useState, useTransition } from "react";
import { Dialog } from "radix-ui";
import { LeadLink } from "@/components/leads/lead-link";
import { CheckCheck, Loader2, Pencil, Trash2, Users, X } from "lucide-react";

import { markNotesRead } from "@/app/(app)/leads/actions";
import { deleteTask, setTaskDone } from "@/app/(app)/my-day/actions";
import { TaskForm } from "@/components/tasks/task-form";
import { Button } from "@/components/ui/button";
import { ClockTime } from "@/components/ui/clock";
import { businessHhmm } from "@/lib/clock";
import { businessDateOf } from "@/lib/dates";
import type { EventKind } from "@/lib/domain";
import { safeAction } from "@/lib/safe-action";
import { cn } from "@/lib/utils";

export type TaskItem = {
  id: number;
  title: string;
  leadId: number | null;
  /** The linked lead's company, for the edit form. */
  leadName?: string | null;
  /** Business-time timestamp; its time is shown in the 12h/24h format the person chose. */
  timestamp: string;
  /** Shown before the time: "Today", "Tomorrow", a date, or nothing (the calendar's day list). */
  whenLabel: string;
  kind: EventKind;
  notes: string;
  isCompleted: boolean;
  isSystem: boolean;
  overdue: boolean;
  assigneeId?: string | null;
  assigneeName?: string | null;
};

/** What the edit dialog needs besides the task. */
export type TaskEditing = { today: string; currentUserId: string; assignees?: { id: string; full_name: string }[] };

function EditTaskDialog({ task, editing }: { task: TaskItem; editing: TaskEditing }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label={`Edit "${task.title}"`}
          title="Edit"
          className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-primary focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Pencil className="size-3.5" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-in bg-black/40 fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-card p-5 shadow-lift">
          <div className="mb-4 flex items-start justify-between gap-2">
            <div>
              <Dialog.Title className="font-semibold">Edit {task.kind === "meeting" ? "meeting" : "task"}</Dialog.Title>
              <Dialog.Description className="text-sm text-muted-foreground">
                Change what, when, the details or the linked lead.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-1 text-muted-foreground hover:text-foreground">
                <X className="size-4" />
              </button>
            </Dialog.Close>
          </div>
          <TaskForm
            today={editing.today}
            currentUserId={editing.currentUserId}
            assignees={editing.assignees}
            task={{
              id: task.id,
              title: task.title,
              kind: task.kind,
              notes: task.notes,
              date: businessDateOf(task.timestamp),
              time: businessHhmm(task.timestamp),
              lead: task.leadId ? { id: task.leadId, client_name: task.leadName || `Lead #${task.leadId}` } : null,
              assigneeId: task.assigneeId ?? null,
            }}
            onDone={() => setOpen(false)}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function TaskList({
  tasks,
  emptyText,
  editing,
  showLead = true,
}: {
  tasks: TaskItem[];
  emptyText: string;
  editing?: TaskEditing;
  /** Off on a lead's own page, where every entry is about that lead. */
  showLead?: boolean;
}) {
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [items, update] = useOptimistic(tasks, (current, change: { id: number; done?: boolean; removed?: boolean }) =>
    change.removed
      ? current.filter((t) => t.id !== change.id)
      : current.map((t) => (t.id === change.id ? { ...t, isCompleted: Boolean(change.done) } : t)),
  );

  if (items.length === 0) return <p className="py-2 text-sm text-muted-foreground">{emptyText}</p>;

  return (
    <div className="space-y-2">
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <ul className="divide-y">
        {items.map((task) => (
          <li key={task.id} className="group flex items-start gap-3 py-2.5">
            <input
              type="checkbox"
              aria-label={`Mark "${task.title}" ${task.isCompleted ? "not done" : "done"}`}
              checked={task.isCompleted}
              onChange={(event) => {
                const done = event.target.checked;
                setError(null);
                startTransition(async () => {
                  update({ id: task.id, done });
                  const result = await safeAction(() => setTaskDone(task.id, done));
                  if (!result.ok) setError(result.error);
                });
              }}
              className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
            />
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm", task.isCompleted && "text-muted-foreground line-through")}>
                {task.kind === "meeting" ? (
                  <Users className="mr-1 inline size-3.5 -translate-y-px text-violet-600" aria-label="Meeting" />
                ) : null}
                {task.leadId && showLead ? (
                  <LeadLink href={`/leads/${task.leadId}`} className="hover:text-primary hover:underline">
                    {task.title}
                  </LeadLink>
                ) : (
                  task.title
                )}
              </p>
              {task.notes ? <p className="line-clamp-2 text-xs whitespace-pre-wrap text-muted-foreground">{task.notes}</p> : null}
              <p className={cn("text-xs text-muted-foreground", task.overdue && !task.isCompleted && "font-medium text-urgent")}>
                {task.overdue && !task.isCompleted ? "Overdue · " : ""}
                {task.whenLabel ? `${task.whenLabel} ` : ""}
                <ClockTime timestamp={task.timestamp} />
                {showLead && task.leadName && !task.title.includes(task.leadName) ? ` · ${task.leadName}` : ""}
                {task.assigneeName ? ` · ${task.assigneeName}` : ""}
              </p>
            </div>
            {!task.isSystem ? (
              <div className="flex shrink-0 items-center">
                {editing ? <EditTaskDialog task={task} editing={editing} /> : null}
                <button
                  type="button"
                  aria-label={`Delete "${task.title}"`}
                  title="Delete"
                  className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                  onClick={() => {
                    setError(null);
                    startTransition(async () => {
                      update({ id: task.id, removed: true });
                      const result = await safeAction(() => deleteTask(task.id));
                      if (!result.ok) setError(result.error);
                    });
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The short planner on My Day and the calendar: details and a lead link sit behind "More". */
export function QuickTaskForm({
  today,
  assignees,
  currentUserId,
  compact = true,
}: {
  today: string;
  /** Present for admins, who can plan tasks for anyone active. */
  assignees?: { id: string; full_name: string }[];
  currentUserId: string;
  compact?: boolean;
}) {
  return <TaskForm today={today} assignees={assignees} currentUserId={currentUserId} compact={compact} />;
}

export function MarkAllReadButton() {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => startTransition(async () => {
          await safeAction(() => markNotesRead(null));
        })}
    >
      {pending ? <Loader2 className="animate-spin" /> : <CheckCheck />}
      Mark all read
    </Button>
  );
}
