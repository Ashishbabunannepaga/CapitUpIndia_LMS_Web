"use client";

import { useOptimistic, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { CheckCheck, Loader2, Plus, Trash2 } from "lucide-react";

import { markNotesRead } from "@/app/(app)/leads/actions";
import { createTask, deleteTask, setTaskDone } from "@/app/(app)/my-day/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

export type TaskItem = {
  id: number;
  title: string;
  leadId: number | null;
  timeLabel: string;
  isCompleted: boolean;
  isSystem: boolean;
  overdue: boolean;
  assigneeName?: string | null;
};

export function TaskList({ tasks, emptyText }: { tasks: TaskItem[]; emptyText: string }) {
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
                  const result = await setTaskDone(task.id, done);
                  if (!result.ok) setError(result.error);
                });
              }}
              className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
            />
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm", task.isCompleted && "text-muted-foreground line-through")}>
                {task.leadId ? (
                  <Link href={`/leads/${task.leadId}`} className="hover:text-primary hover:underline">
                    {task.title}
                  </Link>
                ) : (
                  task.title
                )}
              </p>
              <p className={cn("text-xs text-muted-foreground", task.overdue && !task.isCompleted && "font-medium text-urgent")}>
                {task.overdue && !task.isCompleted ? "Overdue · " : ""}
                {task.timeLabel}
                {task.assigneeName ? ` · ${task.assigneeName}` : ""}
              </p>
            </div>
            {!task.isSystem ? (
              <button
                type="button"
                aria-label={`Delete "${task.title}"`}
                className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                onClick={() => {
                  setError(null);
                  startTransition(async () => {
                    update({ id: task.id, removed: true });
                    const result = await deleteTask(task.id);
                    if (!result.ok) setError(result.error);
                  });
                }}
              >
                <Trash2 className="size-3.5" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function QuickTaskForm({
  today,
  assignees,
  currentUserId,
}: {
  today: string;
  /** Present for admins, who can plan tasks for anyone active. */
  assignees?: { id: string; full_name: string }[];
  currentUserId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      className="space-y-2"
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const result = await createTask(formData);
          if (result.ok) formRef.current?.reset();
          else setError(result.error);
        });
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          name="title"
          required
          maxLength={300}
          placeholder="Plan a task, e.g. Call Rajesh about the GMC quote"
          aria-label="Task"
          className="flex-1"
        />
        <div className="flex gap-2">
          <Input name="date" type="date" defaultValue={today} aria-label="Date" className="w-36" />
          <Input name="time" type="time" defaultValue="10:00" aria-label="Time" className="w-28" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        {assignees ? (
          <NativeSelect name="assignee" size="sm" aria-label="Assign to" defaultValue={currentUserId} className="max-w-56">
            {assignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id === currentUserId ? `Me (${a.full_name})` : a.full_name}
              </option>
            ))}
          </NativeSelect>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <Button type="submit" size="sm" disabled={pending} className="ml-auto">
          {pending ? <Loader2 className="animate-spin" /> : <Plus />}
          Add task
        </Button>
      </div>
    </form>
  );
}

export function MarkAllReadButton() {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => startTransition(() => markNotesRead(null))}
    >
      {pending ? <Loader2 className="animate-spin" /> : <CheckCheck />}
      Mark all read
    </Button>
  );
}
