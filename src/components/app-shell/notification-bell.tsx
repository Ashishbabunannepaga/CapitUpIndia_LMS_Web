"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { AlarmClock, Bell, CheckCheck } from "lucide-react";

import { markNotificationsRead } from "@/app/(app)/notifications/actions";
import { Button } from "@/components/ui/button";
import type { AppNotification } from "@/lib/database.types";
import { formatNoteTimestamp } from "@/lib/dates";
import { cn } from "@/lib/utils";

type Item = Pick<AppNotification, "id" | "title" | "body" | "lead_id" | "created_at" | "read_at">;

/** Renewal reminders delivered by the server job, with an unread count. */
export function NotificationBell({ notifications, unread }: { notifications: Item[]; unread: number }) {
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={panel} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <Bell />
        {unread > 0 ? (
          <span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </Button>

      {open ? (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <p className="text-sm font-semibold">Renewal reminders</p>
            {unread > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => startTransition(() => markNotificationsRead())}
              >
                <CheckCheck className="size-3.5" />
                Mark all read
              </Button>
            ) : null}
          </div>
          {notifications.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Nothing yet. Renewal reminders arrive from 30 days before a renewal date.
            </p>
          ) : (
            <ul className="max-h-96 divide-y overflow-y-auto">
              {notifications.map((item) => (
                <li key={item.id} className={cn(!item.read_at && "bg-accent/50")}>
                  <Link
                    href={item.lead_id ? `/leads/${item.lead_id}` : "/my-day"}
                    className="block px-3 py-2.5 hover:bg-accent"
                    onClick={() => {
                      setOpen(false);
                      if (!item.read_at) startTransition(() => markNotificationsRead(item.id));
                    }}
                  >
                    <p className="flex items-start gap-1.5 text-sm font-medium">
                      <AlarmClock className="mt-0.5 size-3.5 shrink-0 text-warning" />
                      {item.title}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{item.body}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{formatNoteTimestamp(item.created_at)}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
