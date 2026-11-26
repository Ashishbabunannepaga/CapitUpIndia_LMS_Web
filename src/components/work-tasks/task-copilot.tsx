"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { Bot, Loader2, Send, Sparkles, X } from "lucide-react";

import { copilotAskAction, copilotDraftAction, createFromDraftsAction, type TaskDraft } from "@/app/(app)/tasks/copilot-actions";
import { PriorityBadge } from "@/components/work-tasks/task-badges";
import { Button } from "@/components/ui/button";
import { DictateButton } from "@/components/ui/dictate";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/dates";
import { safeAction } from "@/lib/safe-action";
import { cn } from "@/lib/utils";

type Mode = "ask" | "create";

const ADMIN_QUESTIONS = ["What's overdue or blocked?", "Who has the most open work?", "What's waiting on me?", "Summarise the team's P1 tasks"];
const AGENT_QUESTIONS = ["What should I do first today?", "What's overdue?", "What's waiting on me?", "What did the admin last ask me?"];

/**
 * The Task Grid copilot: ask about your tasks in plain words, or describe
 * work and get task drafts to check before they are created.
 */
export function TaskCopilot({ admin }: { admin: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("ask");
  const [answer, setAnswer] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<(TaskDraft & { keep: boolean })[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<number[] | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLTextAreaElement>(null);

  function run(text?: string) {
    const value = (text ?? input.current?.value ?? "").trim();
    if (!value) return;
    if (text && input.current) input.current.value = text;
    setError(null);
    setCreated(null);
    start(async () => {
      if (mode === "ask") {
        setAnswer(null);
        const r = await safeAction(() => copilotAskAction(value));
        if (r.ok && "answer" in r) setAnswer(r.answer);
        else if (!r.ok) setError(r.error);
      } else {
        setDrafts(null);
        const r = await safeAction(() => copilotDraftAction(value));
        if (r.ok && "drafts" in r) setDrafts(r.drafts.map((d) => ({ ...d, keep: true })));
        else if (!r.ok) setError(r.error);
      }
    });
  }

  function createKept() {
    const kept: TaskDraft[] = (drafts ?? [])
      .filter((d) => d.keep)
      .map((d) => ({ title: d.title, description: d.description, assignee_id: d.assignee_id, assignee_name: d.assignee_name, priority: d.priority, due_date: d.due_date, tags: d.tags }));
    if (!kept.length) return;
    setError(null);
    start(async () => {
      const r = await safeAction(() => createFromDraftsAction(kept));
      const ids = "ids" in r ? r.ids : [];
      if (!r.ok) setError(r.error);
      if (ids.length) {
        setCreated(ids);
        setDrafts(null);
        if (input.current) input.current.value = "";
        router.refresh();
      }
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="outline">
          <Bot /> Copilot
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-in bg-black/40 fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-background p-5 shadow-lift sm:p-6">
          <div className="mb-4 flex items-start justify-between gap-2">
            <div>
              <Dialog.Title className="flex items-center gap-2 text-lg font-medium">
                <Sparkles className="size-5 text-gold-600" /> Task copilot
              </Dialog.Title>
              <Dialog.Description className="text-sm text-muted-foreground">
                {admin
                  ? "Ask about the team's tasks, or describe work and it drafts tasks for the right people."
                  : "Ask about your tasks, or describe work and it drafts to-dos (or raises it to an admin)."}{" "}
                It only sees tasks you can already see.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-1 text-muted-foreground hover:text-foreground">
                <X className="size-5" />
              </button>
            </Dialog.Close>
          </div>

          <div className="mb-3 inline-flex rounded-full border p-0.5 text-sm" role="tablist">
            {(["ask", "create"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => {
                  if (m !== mode && input.current) input.current.value = "";
                  setMode(m);
                  setError(null);
                }}
                className={cn("rounded-full px-3 py-1 transition-colors", mode === m ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
              >
                {m === "ask" ? "Ask" : admin ? "Create & assign" : "Create"}
              </button>
            ))}
          </div>

          <div className="space-y-2">
            <Textarea
              ref={input}
              rows={3}
              maxLength={1500}
              aria-label={mode === "ask" ? "Question for the copilot" : "Work to turn into tasks"}
              placeholder={
                mode === "ask"
                  ? "What's overdue? Who is waiting on me?"
                  : admin
                    ? "Sravani: collect KYC from Acme by Friday, urgent. Jyotsna: renewal quote for Zenith next week."
                    : "Call Acme about the claim tomorrow, and raise the GMC rate issue to the admin."
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  run();
                }
              }}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <DictateButton target={input} />
              <Button onClick={() => run()} disabled={pending}>
                {pending ? <Loader2 className="animate-spin" /> : <Send />}
                {mode === "ask" ? "Ask" : "Draft tasks"}
              </Button>
            </div>
            {mode === "ask" && !answer ? (
              <div className="flex flex-wrap gap-1.5">
                {(admin ? ADMIN_QUESTIONS : AGENT_QUESTIONS).map((q) => (
                  <button
                    key={q}
                    type="button"
                    disabled={pending}
                    onClick={() => run(q)}
                    className="rounded-full border bg-card px-3 py-1 text-xs hover:border-primary/40 hover:bg-muted"
                  >
                    {q}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}

          {mode === "ask" && answer ? (
            <div className="mt-4 rounded-xl border bg-card p-4 text-sm whitespace-pre-wrap" aria-live="polite">
              {answer}
            </div>
          ) : null}

          {mode === "create" && drafts ? (
            <div className="mt-4 space-y-2">
              <p className="text-sm font-medium">Check these before they&apos;re created</p>
              <ul className="space-y-2">
                {drafts.map((d, i) => (
                  <li key={i} className={cn("rounded-xl border bg-card p-3 text-sm", !d.keep && "opacity-50")}>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={d.keep}
                        onChange={(e) => setDrafts((all) => all!.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)))}
                        className="mt-1 size-4 accent-primary"
                      />
                      <span className="min-w-0 flex-1 space-y-1">
                        <span className="block font-medium">{d.title}</span>
                        {d.description ? <span className="block text-xs text-muted-foreground">{d.description}</span> : null}
                        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <PriorityBadge priority={d.priority} short />
                          <span>{d.assignee_name === "Me" ? "Your to-do" : `${admin ? "For" : "Raise to"} ${d.assignee_name}`}</span>
                          <span>· {d.due_date ? `Due ${formatDate(d.due_date)}` : "No deadline"}</span>
                          {d.tags.length ? <span>· {d.tags.join(", ")}</span> : null}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex justify-end">
                <Button onClick={createKept} disabled={pending || !drafts.some((d) => d.keep)}>
                  {pending ? <Loader2 className="animate-spin" /> : null}
                  Create {drafts.filter((d) => d.keep).length} task{drafts.filter((d) => d.keep).length === 1 ? "" : "s"}
                </Button>
              </div>
            </div>
          ) : null}

          {created?.length ? (
            <p className="mt-3 text-sm text-emerald-700">
              Created {created.length} task{created.length === 1 ? "" : "s"}. Everyone you gave work to has been notified.
            </p>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
