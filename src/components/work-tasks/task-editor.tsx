"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { Loader2, Pencil, Plus, Sparkles, X } from "lucide-react";

import { createWorkTaskAction, suggestFromLeadAction, updateWorkTaskAction } from "@/app/(app)/tasks/actions";
import { LeadPicker, type LeadRef } from "@/components/tasks/task-form";
import { Button } from "@/components/ui/button";
import { DictateButton } from "@/components/ui/dictate";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/dates";
import { safeAction } from "@/lib/safe-action";
import { parseTags, TASK_PRIORITIES, TASK_PRIORITY_LABELS, type DueSuggestion, type TaskPriority } from "@/lib/work-tasks";

type Member = { id: string; full_name: string };

export type EditableWorkTask = {
  id: number;
  title: string;
  description: string;
  priority: TaskPriority;
  due_date: string;
  due_time: string;
  assignee_id: string;
  tags: string[];
  lead: LeadRef | null;
};

/**
 * New task (or edit). Admins pick who it is for: themselves makes a private
 * to-do, anyone else an assigned task with a shared thread. Linking a lead
 * suggests a due date from its renewal and tags from its product.
 */
export function TaskEditor({
  members,
  currentUserId,
  task,
  defaultAssignee,
  trigger,
}: {
  /** Admins: active team members to give the task to. Agents: undefined (always themselves). */
  members?: Member[];
  currentUserId: string;
  task?: EditableWorkTask;
  defaultAssignee?: string;
  trigger?: "button" | "icon";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [due, setDue] = useState(task?.due_date ?? "");
  const [tags, setTags] = useState((task?.tags ?? []).join(", "));
  const [suggestion, setSuggestion] = useState<{
    due: DueSuggestion | null;
    tags: string[];
  } | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const detailsRef = useRef<HTMLTextAreaElement>(null);
  const editing = Boolean(task);

  function onLead(lead: LeadRef | null) {
    setSuggestion(null);
    if (!lead) return;
    void suggestFromLeadAction(lead.id).then((r) => {
      if (r.ok && (r.due || r.tags.length)) setSuggestion({ due: r.due, tags: r.tags });
    });
  }

  function submit(formData: FormData) {
    setError(null);
    start(async () => {
      const result = await safeAction(() => (task ? updateWorkTaskAction(task.id, formData) : createWorkTaskAction(formData)));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      if (!task && "id" in result && result.id) router.push(`/tasks/${result.id}`);
      else router.refresh();
    });
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setError(null);
      }}
    >
      <Dialog.Trigger asChild>
        {trigger === "icon" ? (
          <Button variant="outline" size="sm">
            <Pencil /> Edit
          </Button>
        ) : (
          <Button>
            <Plus /> New task
          </Button>
        )}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-in bg-black/40 fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-background p-5 shadow-lift sm:p-6">
          <div className="mb-4 flex items-start justify-between gap-2">
            <div>
              <Dialog.Title className="text-lg font-medium">{editing ? "Edit task" : "New task"}</Dialog.Title>
              <Dialog.Description className="text-sm text-muted-foreground">
                {members
                  ? "Give it to someone for a shared thread, or keep it as your own private to-do."
                  : "Only you see your own tasks."}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-1 text-muted-foreground hover:text-foreground">
                <X className="size-5" />
              </button>
            </Dialog.Close>
          </div>

          <form action={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="task-title">Title</Label>
              <div className="flex gap-2">
                <Input
                  id="task-title"
                  ref={titleRef}
                  name="title"
                  required
                  maxLength={200}
                  defaultValue={task?.title}
                  placeholder="Collect KYC documents from Acme"
                />
                <DictateButton target={titleRef} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-details">Details</Label>
              <Textarea
                id="task-details"
                ref={detailsRef}
                name="description"
                rows={3}
                maxLength={5000}
                defaultValue={task?.description}
                placeholder="What done looks like, documents needed, who to call."
              />
              <DictateButton target={detailsRef} />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="task-priority">Priority</Label>
                <NativeSelect id="task-priority" name="priority" defaultValue={task?.priority ?? "P2"}>
                  {TASK_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {TASK_PRIORITY_LABELS[p]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              {members ? (
                <div className="space-y-1.5">
                  <Label htmlFor="task-assignee">For</Label>
                  <NativeSelect
                    id="task-assignee"
                    name="assignee"
                    defaultValue={task?.assignee_id ?? defaultAssignee ?? currentUserId}
                  >
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id === currentUserId ? `Me (private to-do)` : m.full_name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ) : (
                <input type="hidden" name="assignee" value="" />
              )}
              <div className="space-y-1.5">
                <Label htmlFor="task-due">Due date</Label>
                <Input id="task-due" type="date" name="due_date" value={due} onChange={(e) => setDue(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="task-time">Time</Label>
                <Input id="task-time" type="time" name="due_time" defaultValue={task?.due_time || "18:00"} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Lead</Label>
              <LeadPicker defaultLead={task?.lead ?? null} onChange={onLead} />
              {suggestion ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-gold-200 bg-gold-50 px-3 py-2 text-xs text-gold-900">
                  <Sparkles className="size-3.5" />
                  {suggestion.due ? (
                    <button
                      type="button"
                      className="font-medium underline-offset-2 hover:underline"
                      onClick={() => setDue(suggestion.due!.date)}
                    >
                      Due {formatDate(suggestion.due.date)} ({suggestion.due.reason})
                    </button>
                  ) : null}
                  {suggestion.tags.length ? (
                    <button
                      type="button"
                      className="font-medium underline-offset-2 hover:underline"
                      onClick={() => setTags(parseTags([...parseTags(tags), ...suggestion.tags]).join(", "))}
                    >
                      Add tags: {suggestion.tags.join(", ")}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {/* Tags come only from the suggestion chip above (so nothing is added unasked). */}
              <input type="hidden" name="auto_tag" value="off" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-tags">Tags</Label>
              <Input
                id="task-tags"
                name="tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="kyc, renewal, docs pending"
                maxLength={400}
              />
              <p className="text-xs text-muted-foreground">Comma separated, up to 6.</p>
            </div>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button type="button" variant="ghost">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="animate-spin" /> : null}
                {editing ? "Save" : "Create task"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
