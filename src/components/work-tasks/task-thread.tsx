"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BellRing, Loader2, Send, Sparkles, Trash2 } from "lucide-react";

import {
  deleteWorkTaskAction,
  markTaskReadAction,
  nudgeWorkTaskAction,
  postTaskMessageAction,
  setWorkTaskStatusAction,
  summarizeTaskAction,
} from "@/app/(app)/tasks/actions";
import { VoiceMark } from "@/components/work-tasks/task-badges";
import { Button } from "@/components/ui/button";
import { DictateButton } from "@/components/ui/dictate";
import { Textarea } from "@/components/ui/textarea";
import { formatNoteTimestamp } from "@/lib/dates";
import { safeAction } from "@/lib/safe-action";
import { cn } from "@/lib/utils";
import { TASK_STATUS_LABELS, TASK_STATUSES, type TaskStatus } from "@/lib/work-tasks";

export type ThreadMessage = {
  id: number;
  author_id: string | null;
  author_name: string;
  kind: "message" | "system";
  via: "text" | "voice";
  body: string;
  created_at: string;
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

/** The conversation: messages as bubbles, system lines as quiet activity, oldest first. */
export function MessageList({
  messages,
  currentUserId,
  compact = false,
}: {
  messages: ThreadMessage[];
  currentUserId: string;
  compact?: boolean;
}) {
  if (!messages.length)
    return <p className="py-4 text-center text-sm text-muted-foreground">No messages yet. Ask a question or post an update.</p>;
  return (
    <ol className={cn("space-y-3", compact && "space-y-2")}>
      {messages.map((m) =>
        m.kind === "system" ? (
          <li key={m.id} className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            <span className="max-w-[80%] text-center">
              {m.body} · {formatNoteTimestamp(m.created_at)}
            </span>
            <span className="h-px flex-1 bg-border" />
          </li>
        ) : (
          <li key={m.id} className={cn("flex gap-2.5", m.author_id === currentUserId && "flex-row-reverse")}>
            {!compact ? (
              <span
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-medium text-brand-800"
                aria-hidden
              >
                {initials(m.author_name)}
              </span>
            ) : null}
            <div
              className={cn(
                "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm",
                m.author_id === currentUserId ? "rounded-tr-sm bg-primary text-primary-foreground" : "rounded-tl-sm bg-muted",
              )}
            >
              <p
                className={cn(
                  "mb-0.5 flex items-center gap-2 text-[11px]",
                  m.author_id === currentUserId ? "text-primary-foreground/75" : "text-muted-foreground",
                )}
              >
                <span className="font-medium">{m.author_id === currentUserId ? "You" : m.author_name}</span>
                <span>{formatNoteTimestamp(m.created_at)}</span>
                {m.via === "voice" ? <VoiceMark /> : null}
              </p>
              <p className="break-words whitespace-pre-wrap">{m.body}</p>
            </div>
          </li>
        ),
      )}
    </ol>
  );
}

/** Reply box with dictation; a dictated reply is marked as voice in the thread. */
export function Composer({
  taskId,
  placeholder = "Reply, ask a question or post an update…",
  autoFocus = false,
}: {
  taskId: number;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [voice, setVoice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function send() {
    const body = ref.current?.value.trim() ?? "";
    if (!body) return;
    setError(null);
    start(async () => {
      const result = await safeAction(() => postTaskMessageAction(taskId, body, voice ? "voice" : "text"));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (ref.current) ref.current.value = "";
      setVoice(false);
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <Textarea
        ref={ref}
        rows={2}
        maxLength={4000}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-label="Message"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <div onClickCapture={() => setVoice(true)}>
          <DictateButton target={ref} />
        </div>
        <div className="flex items-center gap-2">
          {error ? <span className="text-xs text-destructive">{error}</span> : null}
          <Button size="sm" onClick={send} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <Send />}
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Marks the thread read once it is on screen (not when a link merely prefetches the page). */
export function MarkRead({ taskId, latest }: { taskId: number; latest: number }) {
  useEffect(() => {
    void markTaskReadAction(taskId);
  }, [taskId, latest]);
  return null;
}

export function StatusButtons({ taskId, status }: { taskId: number; status: TaskStatus }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [blockNote, setBlockNote] = useState<string | null>(null);

  function move(next: TaskStatus, note?: string) {
    setError(null);
    start(async () => {
      const result = await safeAction(() => setWorkTaskStatusAction(taskId, next, note));
      if (!result.ok) setError(result.error);
      else {
        setBlockNote(null);
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Status">
        {TASK_STATUSES.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={s === status ? "default" : "outline"}
            disabled={pending || s === status}
            onClick={() => (s === "blocked" ? setBlockNote("") : move(s))}
          >
            {TASK_STATUS_LABELS[s]}
          </Button>
        ))}
      </div>
      {blockNote !== null ? (
        <div className="space-y-2 rounded-md border border-red-200 bg-red-50/50 p-2">
          <Textarea
            rows={2}
            value={blockNote}
            onChange={(e) => setBlockNote(e.target.value)}
            placeholder="What is it blocked on? (goes into the thread)"
            maxLength={4000}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setBlockNote(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="destructive" disabled={pending} onClick={() => move("blocked", blockNote)}>
              Mark blocked
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function NudgeButton({ taskId, name }: { taskId: number; name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await safeAction(() => nudgeWorkTaskAction(taskId));
            setNote(r.ok ? `Nudged ${name}.` : r.error);
            if (r.ok) router.refresh();
          })
        }
      >
        <BellRing /> Nudge {name.split(" ")[0]}
      </Button>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

export function DeleteTaskButton({ taskId }: { taskId: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!confirm)
    return (
      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirm(true)}>
        <Trash2 /> Delete
      </Button>
    );
  return (
    <span className="flex items-center gap-2 text-xs">
      Delete with its thread?
      <Button
        size="sm"
        variant="destructive"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await safeAction(() => deleteWorkTaskAction(taskId));
            if (!r.ok) setError(r.error);
            else router.push("/tasks");
          })
        }
      >
        Delete
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
        Keep
      </Button>
      {error ? <span className="text-destructive">{error}</span> : null}
    </span>
  );
}

export function SummaryButton({ taskId }: { taskId: number }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ text: string; note?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await safeAction(() => summarizeTaskAction(taskId));
            if (!r.ok) setError(r.error);
            else
              setResult({
                text: r.text,
                note: r.source === "rules" ? "Summary by rules (AI not used)." : undefined,
              });
          })
        }
      >
        {pending ? <Loader2 className="animate-spin" /> : <Sparkles />}
        Catch me up
      </Button>
      {result ? (
        <div className="rounded-md border border-gold-200 bg-gold-50 p-3 text-sm whitespace-pre-wrap text-gold-900">
          {result.text}
          {result.note ? <p className="mt-1 text-[11px] text-muted-foreground">{result.note}</p> : null}
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
