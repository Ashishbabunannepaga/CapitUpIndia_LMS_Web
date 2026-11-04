import type { ReactNode } from "react";

import { TONE_CLASS, type Tone } from "@/lib/office-labels";
import type { GapCounts } from "@/lib/office";
import { cn } from "@/lib/utils";

export function Tag({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONE_CLASS[tone], className)}>
      {children}
    </span>
  );
}

export function GapChips({ gaps }: { gaps?: GapCounts | null }) {
  if (!gaps) return <span className="text-xs text-muted-foreground">No report yet</span>;
  const none = !gaps.HIGH && !gaps.MEDIUM && !gaps.LOW;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {gaps.HIGH > 0 ? <Tag tone="risk">{gaps.HIGH} high</Tag> : null}
      {gaps.MEDIUM > 0 ? <Tag tone="warn">{gaps.MEDIUM} medium</Tag> : null}
      {gaps.LOW > 0 ? <Tag tone="info">{gaps.LOW} low</Tag> : null}
      {none ? <Tag tone="good">No gaps flagged</Tag> : null}
    </span>
  );
}

export function DaysLeft({ days }: { days: number }) {
  const tone = days < 0 ? "text-muted-foreground" : days <= 7 ? "text-rose-600" : days <= 30 ? "text-amber-600" : "text-sky-700";
  return (
    <span className={cn("flex w-16 shrink-0 flex-col items-center leading-tight", tone)}>
      <strong className="text-xl tabular-nums">{Math.abs(days)}</strong>
      <small className="text-[11px]">{days < 0 ? "days ago" : days === 1 ? "day left" : "days left"}</small>
    </span>
  );
}

/** The one-line result of the last form, carried in ?ok= / ?error=. */
export function ResultNote({ ok, error }: { ok?: string; error?: string }) {
  if (!ok && !error) return null;
  return (
    <p
      role={error ? "alert" : "status"}
      className={cn(
        "mb-4 rounded-md border px-3 py-2 text-sm",
        error ? "border-rose-200 bg-rose-50 text-rose-800" : "border-emerald-200 bg-emerald-50 text-emerald-800",
      )}
    >
      {(error ?? ok)?.slice(0, 300)}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

export function Initials({ name, tone = "accent" }: { name?: string | null; tone?: Tone }) {
  const text =
    (name || "?")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "?";
  return (
    <span aria-hidden="true" className={cn("flex size-9 shrink-0 items-center justify-center rounded-full border text-xs font-semibold", TONE_CLASS[tone])}>
      {text}
    </span>
  );
}
