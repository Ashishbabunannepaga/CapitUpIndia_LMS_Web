import { AlarmClock, CalendarClock, Mic, Tag } from "lucide-react";

import { formatDateTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import {
  dueState,
  TASK_PRIORITY_LABELS,
  TASK_PRIORITY_STYLES,
  TASK_STATUS_LABELS,
  TASK_STATUS_STYLES,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/work-tasks";

const chip = "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap";

export function PriorityBadge({ priority, short = false }: { priority: TaskPriority; short?: boolean }) {
  return (
    <span className={cn(chip, TASK_PRIORITY_STYLES[priority])} title={TASK_PRIORITY_LABELS[priority]}>
      {short ? priority : TASK_PRIORITY_LABELS[priority]}
    </span>
  );
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <span className={cn(chip, TASK_STATUS_STYLES[status])}>{TASK_STATUS_LABELS[status]}</span>;
}

/** Due time, coloured by urgency (overdue red, today amber). */
export function DueChip({ dueAt, done = false, now }: { dueAt: string | null; done?: boolean; now?: Date }) {
  if (!dueAt) return <span className={cn(chip, "border-dashed text-muted-foreground")}>No deadline</span>;
  const state = done ? "later" : dueState(dueAt, now);
  return (
    <span
      className={cn(
        chip,
        state === "overdue"
          ? "border-red-200 bg-red-50 text-red-700"
          : state === "today"
            ? "border-amber-200 bg-amber-50 text-amber-800"
            : "bg-card text-muted-foreground",
      )}
    >
      {state === "overdue" ? <AlarmClock className="size-3" /> : <CalendarClock className="size-3" />}
      {state === "overdue" ? "Overdue · " : state === "today" ? "Today · " : ""}
      {formatDateTime(dueAt)}
    </span>
  );
}

export function TagChips({ tags, className }: { tags: readonly string[]; className?: string }) {
  if (!tags.length) return null;
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {tags.map((tag) => (
        <span key={tag} className={cn(chip, "border-brand-100 bg-brand-50 text-brand-800")}>
          <Tag className="size-3" />
          {tag}
        </span>
      ))}
    </span>
  );
}

export function VoiceMark({ recorded = false }: { recorded?: boolean }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px]" title={recorded ? "Voice note, with an AI transcript" : "Dictated"}>
      <Mic className="size-3" /> {recorded ? "voice note" : "voice"}
    </span>
  );
}

export function RaisedBadge() {
  return (
    <span
      className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-1.5 py-px text-[11px] font-medium text-violet-700"
      title="An agent raised this to an admin"
    >
      Raised
    </span>
  );
}

export function UnreadDot({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground tabular-nums">
      {count}
    </span>
  );
}
