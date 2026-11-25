"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, MessageSquareText, Pin, X } from "lucide-react";

import { DueChip, PriorityBadge, TagChips, UnreadDot } from "@/components/work-tasks/task-badges";
import { Composer, MessageList, type ThreadMessage } from "@/components/work-tasks/task-thread";
import { cn } from "@/lib/utils";
import type { TaskPriority, TaskStatus } from "@/lib/work-tasks";

export type PinnedItem = {
  id: number;
  title: string;
  priority: TaskPriority;
  status: TaskStatus;
  due_at: string | null;
  tags: string[];
  unread: number;
  role: "incoming" | "given";
  created_by_name: string;
  assignee_name: string | null;
  lead_name: string | null;
  recent: ThreadMessage[];
};

const DISMISS_KEY = "pinned-tasks-dismissed";

/**
 * The My Day header pin: tasks an admin gave you (urgent first) and, for
 * whoever gave tasks, ones waiting on them. Opens by itself when something is
 * urgent or unread (until closed for that state), and each task expands to
 * its latest messages with a reply box.
 */
export function PinnedTasks({ items, currentUserId }: { items: PinnedItem[]; currentUserId: string }) {
  const incoming = items.filter((i) => i.role === "incoming");
  const given = items.filter((i) => i.role === "given");
  const unread = items.reduce((n, i) => n + i.unread, 0);
  const urgent = incoming.some((i) => i.priority === "P1");
  // What makes it pop open; closing it remembers this state, so it stays shut until something changes.
  const signature = items.map((i) => `${i.id}:${i.unread}:${i.priority}`).join(",");
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!(urgent || unread)) return;
    let dismissed: string | null = null;
    try {
      dismissed = sessionStorage.getItem(DISMISS_KEY);
    } catch {
      // Storage blocked: just open it.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opening once on load from stored state
    if (dismissed !== signature) setOpen(true);
  }, [signature, urgent, unread]);

  function close() {
    setOpen(false);
    try {
      sessionStorage.setItem(DISMISS_KEY, signature);
    } catch {
      // Not remembered; fine.
    }
  }

  if (!items.length) return null;

  const label = incoming.length
    ? `${incoming.length} task${incoming.length === 1 ? "" : "s"} from admin`
    : `${given.length} task${given.length === 1 ? "" : "s"} need${given.length === 1 ? "s" : ""} you`;

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium ring-1 transition-colors",
          urgent
            ? "bg-red-500/90 text-white ring-red-300/60 hover:bg-red-500"
            : "bg-white/10 text-white ring-white/20 hover:bg-white/15",
        )}
      >
        <Pin className="size-4" />
        {label}
        {unread ? (
          <span className="rounded-full bg-white px-1.5 text-[11px] text-brand-800 tabular-nums">{unread} new</span>
        ) : null}
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <div className="fixed inset-x-3 top-16 z-40 sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-2 sm:w-[540px] overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-lift">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <p className="text-sm font-medium">Pinned tasks</p>
            <div className="flex items-center gap-2">
              <Link href="/tasks?view=mine" className="text-xs text-muted-foreground hover:text-primary">
                Task Grid
              </Link>
              <button
                type="button"
                aria-label="Close pinned tasks"
                onClick={close}
                className="rounded p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
          <ul className="max-h-[70vh] divide-y overflow-y-auto">
            {items.map((item) => {
              const isOpen = expanded === item.id;
              return (
                <li key={item.id} className={cn(item.unread > 0 && "bg-accent/40")}>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : item.id)}
                    aria-expanded={isOpen}
                    className="flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-muted/60"
                  >
                    {isOpen ? (
                      <ChevronDown className="mt-0.5 size-4 shrink-0" />
                    ) : (
                      <ChevronRight className="mt-0.5 size-4 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex items-start justify-between gap-2">
                        <span className="text-sm font-medium">{item.title}</span>
                        <UnreadDot count={item.unread} />
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <PriorityBadge priority={item.priority} short />
                        <DueChip dueAt={item.due_at} />
                        <span>
                          {item.role === "incoming"
                            ? `by ${item.created_by_name || "an admin"}`
                            : `${item.assignee_name ?? "Assignee"} · ${item.status === "blocked" ? "blocked" : "replied"}`}
                        </span>
                      </span>
                      <TagChips tags={item.tags} />
                    </span>
                  </button>
                  {isOpen ? (
                    <div className="space-y-3 px-4 pb-4">
                      {item.lead_name ? <p className="text-xs text-muted-foreground">Lead: {item.lead_name}</p> : null}
                      <MessageList messages={item.recent} currentUserId={currentUserId} compact />
                      <Composer
                        taskId={item.id}
                        placeholder={item.role === "incoming" ? "Ask the admin or post an update…" : "Reply…"}
                      />
                      <Link
                        href={`/tasks/${item.id}`}
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        <MessageSquareText className="size-3.5" /> Open full thread
                      </Link>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
