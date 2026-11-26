"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { LayoutTemplate, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";

import { deleteTaskTemplateAction, saveTaskTemplateAction } from "@/app/(app)/tasks/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { safeAction } from "@/lib/safe-action";
import { TASK_PRIORITIES, TASK_PRIORITY_LABELS, type TaskPriority } from "@/lib/work-tasks";

export type TemplateDraft = {
  id?: number;
  name: string;
  title: string;
  description: string;
  priority: TaskPriority;
  tags: string;
  due_in_days: number | null;
  shared: boolean;
};

/**
 * Create or edit a task template. "Save as template" on a task opens it
 * pre-filled from that task. Only admins see the "share with the team" box.
 */
export function TemplateDialog({
  draft,
  admin,
  trigger,
}: {
  draft?: TemplateDraft;
  admin: boolean;
  trigger: "new" | "edit" | "save-from-task";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  function submit(formData: FormData) {
    setError(null);
    start(async () => {
      const result = await safeAction(() => saveTaskTemplateAction(trigger === "edit" ? (draft?.id ?? null) : null, formData));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setSaved(trigger === "save-from-task");
      router.refresh();
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
        {trigger === "edit" ? (
          <Button variant="ghost" size="sm" aria-label={`Edit template ${draft?.name ?? ""}`}>
            <Pencil />
          </Button>
        ) : trigger === "new" ? (
          <Button>
            <Plus /> New template
          </Button>
        ) : (
          <Button variant="outline" size="sm">
            <LayoutTemplate /> {saved ? "Saved as template" : "Save as template"}
          </Button>
        )}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-in bg-black/40 fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-background p-5 shadow-lift sm:p-6">
          <div className="mb-4 flex items-start justify-between gap-2">
            <div>
              <Dialog.Title className="text-lg font-medium">{trigger === "edit" ? "Edit template" : "New template"}</Dialog.Title>
              <Dialog.Description className="text-sm text-muted-foreground">
                Pick it under New task to fill in the title, details, priority, tags and due date.
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
              <Label htmlFor="tpl-name">Template name</Label>
              <Input id="tpl-name" name="name" required maxLength={80} defaultValue={draft?.name} placeholder="Renewal re-quote" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-title">Task title</Label>
              <Input id="tpl-title" name="title" required maxLength={200} defaultValue={draft?.title} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-details">Details or checklist</Label>
              <Textarea
                id="tpl-details"
                name="description"
                rows={4}
                maxLength={5000}
                defaultValue={draft?.description}
                placeholder={"- Collect last year's policy\n- Ask for the employee list\n- Send to 3 insurers"}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tpl-priority">Priority</Label>
                <NativeSelect id="tpl-priority" name="priority" defaultValue={draft?.priority ?? "P2"}>
                  {TASK_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {TASK_PRIORITY_LABELS[p]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-due">Due in (days)</Label>
                <Input
                  id="tpl-due"
                  name="due_in_days"
                  type="number"
                  min={0}
                  max={365}
                  defaultValue={draft?.due_in_days ?? ""}
                  placeholder="No deadline"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-tags">Tags</Label>
              <Input id="tpl-tags" name="tags" maxLength={400} defaultValue={draft?.tags} placeholder="renewal, gmc" />
            </div>
            {admin ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="shared" defaultChecked={draft?.shared} className="size-4 accent-primary" />
                Share with the whole team
              </label>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button type="button" variant="ghost">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="animate-spin" /> : null}
                Save template
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function DeleteTemplateButton({ id, name }: { id: number; name: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!confirming)
    return (
      <Button variant="ghost" size="sm" aria-label={`Delete template ${name}`} onClick={() => setConfirming(true)}>
        <Trash2 />
      </Button>
    );
  return (
    <span className="inline-flex items-center gap-1">
      <Button
        variant="destructive"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await safeAction(() => deleteTaskTemplateAction(id));
            if (!result.ok) setError(result.error);
            else router.refresh();
          })
        }
      >
        {pending ? <Loader2 className="animate-spin" /> : null}
        Delete
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
        Keep
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}
