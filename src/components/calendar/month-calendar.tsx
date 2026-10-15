"use client";

import { useState } from "react";
import Link from "next/link";
import { CalendarClock, CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";

import { TaskList, type TaskItem } from "@/components/my-day/my-day-widgets";
import { Button } from "@/components/ui/button";
import { formatDate, formatTime } from "@/lib/dates";
import {
  CALENDAR_CATEGORIES,
  CALENDAR_CATEGORY_LABELS,
  CALENDAR_CATEGORY_STYLES,
  type CalendarCategory,
} from "@/lib/domain";
import { cn } from "@/lib/utils";

export type CalendarEntry = {
  id: number;
  title: string;
  /** Business-time date, YYYY-MM-DD. */
  date: string;
  timestamp: string;
  leadId: number | null;
  isRenewal: boolean;
  /** Its colours: GMC or retail renewal, active client, task. */
  categories: CalendarCategory[];
  isCompleted: boolean;
  isSystem: boolean;
  agentName?: string | null;
};

type Filter = "all" | CalendarCategory;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
}

function shiftMonth(month: string, by: number): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
}

/** The 6-week grid (Monday first) covering a month. */
function gridDays(month: string): string[] {
  const first = new Date(`${month}-01T00:00:00Z`);
  const offset = (first.getUTCDay() + 6) % 7;
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

/** Short label for a day cell, e.g. "2 GMC" or "1 task"; the full name is in its tooltip. */
function cellLabel(category: CalendarCategory, n: number): string {
  switch (category) {
    case "gmc_renewal":
      return "GMC";
    case "retail_renewal":
      return "retail";
    case "active_client":
      return "active";
    case "task":
      return n === 1 ? "task" : "tasks";
  }
}

/** Month grid of renewals and tasks, with the selected day's list beside it. */
export function MonthCalendar({
  entries,
  today,
  initialMonth,
  showAgent,
}: {
  entries: CalendarEntry[];
  today: string;
  initialMonth: string;
  showAgent: boolean;
}) {
  const [month, setMonth] = useState(initialMonth);
  const [selected, setSelected] = useState(today.startsWith(initialMonth) ? today : `${initialMonth}-01`);

  const [filter, setFilter] = useState<Filter>("all");

  const totals = new Map<CalendarCategory, number>();
  for (const entry of entries) {
    if (!entry.date.startsWith(month)) continue;
    for (const c of entry.categories) totals.set(c, (totals.get(c) ?? 0) + 1);
  }
  const shown = filter === "all" ? entries : entries.filter((e) => e.categories.includes(filter));

  const byDay = new Map<string, CalendarEntry[]>();
  for (const entry of shown) {
    byDay.set(entry.date, [...(byDay.get(entry.date) ?? []), entry]);
  }
  const days = gridDays(month);
  const dayEntries = (byDay.get(selected) ?? []).sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const tasks: TaskItem[] = dayEntries
    .filter((e) => !e.isRenewal)
    .map((e) => ({
      id: e.id,
      title: e.title,
      leadId: e.leadId,
      isCompleted: e.isCompleted,
      isSystem: e.isSystem,
      overdue: e.date < today && !e.isCompleted,
      timeLabel: formatTime(e.timestamp),
    }));
  const renewals = dayEntries.filter((e) => e.isRenewal);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <section className="rounded-2xl border bg-card p-4 shadow-card">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">{monthLabel(month)}</h2>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
              <ChevronLeft />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMonth(today.slice(0, 7))}>
              Today
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">
              <ChevronRight />
            </Button>
          </div>
        </header>

        <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Calendar filter">
          {(["all", ...CALENDAR_CATEGORIES] as const).map((option) => {
            const active = filter === option;
            const count = option === "all" ? undefined : (totals.get(option) ?? 0);
            return (
              <button
                key={option}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(option)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  active
                    ? option === "all"
                      ? "border-primary bg-primary text-primary-foreground"
                      : CALENDAR_CATEGORY_STYLES[option].chip
                    : "bg-card text-foreground hover:bg-accent",
                )}
              >
                {option === "all" ? null : (
                  <span
                    className={cn("size-2 rounded-full", active ? "bg-white" : CALENDAR_CATEGORY_STYLES[option].dot)}
                    aria-hidden="true"
                  />
                )}
                {option === "all" ? "All" : CALENDAR_CATEGORY_LABELS[option]}
                {count !== undefined ? <span className="tabular-nums opacity-75">{count}</span> : null}
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-7 gap-px text-center text-xs font-medium text-muted-foreground">
          {WEEKDAYS.map((day) => (
            <div key={day} className="py-1">
              {day}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border bg-border">
          {days.map((day) => {
            const items = byDay.get(day) ?? [];
            const counts = CALENDAR_CATEGORIES.map((c) => [c, items.filter((i) => i.categories.includes(c)).length] as const).filter(
              ([c, n]) => n > 0 && (filter === "all" || filter === c),
            );
            const inMonth = day.startsWith(month);
            return (
              <button
                key={day}
                type="button"
                onClick={() => setSelected(day)}
                aria-pressed={selected === day}
                className={cn(
                  "min-h-20 bg-card p-1.5 text-left transition-colors hover:bg-accent",
                  !inMonth && "bg-muted/40 text-muted-foreground",
                  selected === day && "ring-2 ring-primary ring-inset",
                )}
              >
                <span
                  className={cn(
                    "inline-flex size-6 items-center justify-center rounded-full text-xs",
                    day === today && "bg-primary font-semibold text-primary-foreground",
                  )}
                >
                  {Number(day.slice(8))}
                </span>
                <span className="mt-1 flex flex-col gap-0.5">
                  {counts.map(([c, n]) => (
                    <span
                      key={c}
                      title={CALENDAR_CATEGORY_LABELS[c]}
                      className={cn(
                        "flex items-center gap-1 truncate rounded px-1 text-[10px] font-medium",
                        CALENDAR_CATEGORY_STYLES[c].pill,
                      )}
                    >
                      <span className={cn("size-1.5 shrink-0 rounded-full", CALENDAR_CATEGORY_STYLES[c].dot)} aria-hidden="true" />
                      <span className="truncate tabular-nums">
                        {n}
                        <span className="hidden sm:inline"> {cellLabel(c, n)}</span>
                      </span>
                    </span>
                  ))}
                </span>
              </button>
            );
          })}
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Colour key">
          {CALENDAR_CATEGORIES.map((c) => (
            <li key={c} className="flex items-center gap-1.5">
              <span className={cn("size-2.5 rounded-full", CALENDAR_CATEGORY_STYLES[c].dot)} aria-hidden="true" />
              {CALENDAR_CATEGORY_LABELS[c]}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border bg-card shadow-card">
        <header className="border-b px-5 py-3">
          <h2 className="text-sm font-semibold">{formatDate(selected)}</h2>
        </header>
        <div className="space-y-4 px-5 py-4">
          <div>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Renewals</h3>
            {renewals.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">No renewals due.</p>
            ) : (
              <ul className="divide-y">
                {renewals.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-2 py-2 text-sm">
                    {entry.isCompleted ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                    ) : (
                      <CalendarClock className="mt-0.5 size-4 shrink-0 text-warning" />
                    )}
                    <span className="mt-1.5 flex shrink-0 gap-0.5" aria-hidden="true">
                      {entry.categories.map((c) => (
                        <span key={c} className={cn("size-2 rounded-full", CALENDAR_CATEGORY_STYLES[c].dot)} />
                      ))}
                    </span>
                    <div className="min-w-0">
                      {entry.leadId ? (
                        <Link href={`/leads/${entry.leadId}`} className="font-medium hover:text-primary hover:underline">
                          {entry.title}
                        </Link>
                      ) : (
                        <span className="font-medium">{entry.title}</span>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {entry.categories.map((c) => CALENDAR_CATEGORY_LABELS[c]).join(" · ")} · {formatTime(entry.timestamp)}
                        {showAgent && entry.agentName ? ` · ${entry.agentName}` : ""}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Tasks</h3>
            <TaskList tasks={tasks} emptyText="Nothing planned." />
          </div>
        </div>
      </section>
    </div>
  );
}
