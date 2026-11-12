import Link from "next/link";
import type { LucideIcon } from "lucide-react";

import { CountUp } from "@/components/ui/count-up";
import { formatCount } from "@/lib/analytics";
import { cn } from "@/lib/utils";

// Small server-rendered charts: no chart library. Motion is CSS only (bars
// grow, rings draw, once on load) and switches off under prefers-reduced-motion; the only
// client JavaScript is the number roll in CountUp.

export type Tone = "default" | "urgent" | "warning" | "success" | "brand" | "gold";

const monthShortFormat = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });

// Figures stay in the text colour unless they need attention; brand, gold and
// success read as neutral so the alarm colours keep their meaning.
const TONE_VALUE: Record<Tone, string> = {
  default: "",
  brand: "",
  gold: "",
  urgent: "text-urgent",
  warning: "text-warning",
  success: "",
};

/** A label and a figure. Colour only when the number needs attention. */
export function StatCard({
  label,
  value,
  hint,
  href,
  tone = "default",
  quiet = false,
}: {
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
  tone?: Tone;
  /** A zero that needs no attention: drop the alarm colour. */
  quiet?: boolean;
}) {
  const t = quiet ? "default" : tone;
  const body = (
    <>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={cn("mt-2 text-[28px] leading-none font-medium tracking-tight tabular-nums", TONE_VALUE[t])}>
        {typeof value === "number" ? <CountUp value={value} /> : value}
      </p>
      {hint ? <p className="mt-2 text-xs text-muted-foreground">{hint}</p> : null}
    </>
  );
  const className = "surface block p-4";
  return href ? (
    <Link href={href} className={cn(className, "lift")}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

export function Panel({
  title,
  description,
  icon: Icon,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("surface overflow-hidden", className)}>
      <header className="flex items-start justify-between gap-3 border-b px-5 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          {Icon ? <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : null}
          <div className="min-w-0">
            <h2 className="text-sm font-medium">{title}</h2>
            {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          </div>
        </div>
        {actions}
      </header>
      <div className={cn("px-5 py-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export type BarDatum = { label: string; value: number; href?: string; colorClass?: string; valueLabel?: string };

/** Horizontal bars, sized against the largest value; they grow in on load. */
export function BarList({ data, emptyText = "No data yet." }: { data: BarDatum[]; emptyText?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (data.length === 0 || data.every((d) => d.value === 0)) {
    return <p className="py-2 text-sm text-muted-foreground">{emptyText}</p>;
  }
  return (
    <ul className="space-y-3">
      {data.map((item, i) => (
        <li key={item.label} className="space-y-2">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            {item.href ? (
              <Link href={item.href} className="truncate hover:text-primary hover:underline">
                {item.label}
              </Link>
            ) : (
              <span className="truncate">{item.label}</span>
            )}
            <span className="shrink-0 tabular-nums">
              <span className="font-medium">{item.valueLabel ?? formatCount(item.value)}</span>
              {!item.valueLabel && total > 0 ? (
                <span className="ml-1.5 text-xs text-muted-foreground">{Math.round((item.value / total) * 100)}%</span>
              ) : null}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full origin-left animate-grow-x rounded-full", item.colorClass ?? "bg-brand-500")}
              style={{ width: `${Math.round((item.value / max) * 100)}%`, animationDelay: `${Math.min(i, 5) * 50}ms` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Monthly columns, for renewals and leads created. */
export function MonthBars({
  data,
  colorClass = "bg-brand-500",
}: {
  data: { month: string; count: number }[];
  colorClass?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const label = (month: string) => monthShortFormat.format(new Date(`${month}-01T00:00:00Z`));
  return (
    <div className="flex items-end gap-1.5" role="img" aria-label={data.map((d) => `${label(d.month)}: ${d.count}`).join(", ")}>
      {data.map((item, i) => (
        <div key={item.month} className="group flex min-w-0 flex-1 flex-col items-center gap-1">
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums group-hover:text-foreground">
            {item.count || ""}
          </span>
          <div
            className={cn(
              "w-full origin-bottom animate-grow-y rounded-t transition-opacity duration-150 group-hover:opacity-80",
              item.count > 0 ? colorClass : "bg-muted",
            )}
            style={{ height: `${Math.max(3, Math.round((item.count / max) * 110))}px`, animationDelay: `${Math.min(i, 5) * 50}ms` }}
          />
          <span className="truncate font-mono text-[11px] text-muted-foreground">{label(item.month)}</span>
        </div>
      ))}
    </div>
  );
}

/** A ring that draws itself to `value` of `max`. */
export function ProgressRing({
  value,
  max,
  size = 72,
  stroke = 8,
  className,
  trackClassName = "stroke-muted",
  barClassName = "stroke-brand-500",
  children,
  label,
}: {
  value: number;
  max: number;
  size?: number;
  stroke?: number;
  className?: string;
  trackClassName?: string;
  barClassName?: string;
  children?: React.ReactNode;
  label: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const fraction = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div className={cn("relative inline-flex shrink-0 items-center justify-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className={trackClassName} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - fraction)}
          className={cn("animate-draw", barClassName)}
          style={{ "--draw-from": c } as React.CSSProperties}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}

export type DonutSlice = { label: string; value: number; color: string; href?: string };

/** A donut of shares with a legend; each segment draws in turn. */
export function Donut({
  data,
  size = 148,
  stroke = 18,
  centerLabel,
  centerValue,
}: {
  data: DonutSlice[];
  size?: number;
  stroke?: number;
  centerLabel: string;
  centerValue: number;
}) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const gap = total > 0 && data.filter((d) => d.value > 0).length > 1 ? 2 : 0;
  let offset = 0;
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center xl:flex-col 2xl:flex-row">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="-rotate-90"
          role="img"
          aria-label={data.map((d) => `${d.label}: ${d.value}`).join(", ")}
        >
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-muted" />
          {total > 0
            ? data.map((slice, i) => {
                if (slice.value === 0) return null;
                const length = (slice.value / total) * c;
                const visible = Math.max(0.001, length - gap);
                const segment = (
                  <circle
                    key={slice.label}
                    cx={size / 2}
                    cy={size / 2}
                    r={r}
                    fill="none"
                    stroke={slice.color}
                    strokeWidth={stroke}
                    strokeDasharray={`${visible} ${c - visible}`}
                    strokeDashoffset={-offset}
                    className="animate-draw"
                    style={{ "--draw-from": c - offset, animationDelay: `${Math.min(i, 5) * 50}ms` } as React.CSSProperties}
                  >
                    <title>{`${slice.label}: ${slice.value}`}</title>
                  </circle>
                );
                offset += length;
                return segment;
              })
            : null}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <CountUp value={centerValue} className="text-2xl leading-none font-medium tracking-tight tabular-nums" />
          <span className="mt-1 text-[11px] text-muted-foreground">{centerLabel}</span>
        </div>
      </div>
      <ul className="grid w-full min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-1 xl:grid-cols-2 2xl:grid-cols-1">
        {data.map((slice) => {
          const row = (
            <>
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: slice.color }} />
              <span className="min-w-0 flex-1 truncate">{slice.label}</span>
              <span className="font-medium tabular-nums">{formatCount(slice.value)}</span>
            </>
          );
          return (
            <li key={slice.label}>
              {slice.href ? (
                <Link href={slice.href} className="-mx-1.5 flex items-center gap-2 rounded px-1.5 py-0.5 hover:bg-muted">
                  {row}
                </Link>
              ) : (
                <span className="flex items-center gap-2 py-0.5">{row}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export type GroupedSeries = { key: string; label: string; colorClass: string; swatch: string };
export type GroupedDatum = { label: string; href?: string; values: Record<string, number> };

/**
 * Grouped columns: one group per item along the bottom, one bar per series
 * side by side (e.g. each agent's open leads, overdue follow-ups and
 * renewals this week). Scrolls sideways on narrow screens.
 */
export function GroupedBars({
  data,
  series,
  emptyText = "No data yet.",
}: {
  data: GroupedDatum[];
  series: GroupedSeries[];
  emptyText?: string;
}) {
  if (data.length === 0) return <p className="py-2 text-sm text-muted-foreground">{emptyText}</p>;
  const max = Math.max(1, ...data.flatMap((d) => series.map((s) => d.values[s.key] ?? 0)));
  return (
    <div>
      <ul className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: s.swatch }} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-max items-end gap-6 border-b px-1 sm:min-w-0">
          {data.map((group, gi) => (
            <div
              key={group.label}
              role="img"
              aria-label={`${group.label}: ${series.map((s) => `${s.label} ${group.values[s.key] ?? 0}`).join(", ")}`}
              className="flex min-w-24 flex-1 flex-col items-center"
            >
              <div className="flex h-40 items-end gap-1">
                {series.map((s, si) => {
                  const value = group.values[s.key] ?? 0;
                  return (
                    <div key={s.key} className="group flex w-6 flex-col items-center justify-end gap-1 sm:w-7" title={`${s.label}: ${value}`}>
                      <span className="font-mono text-[11px] text-muted-foreground tabular-nums group-hover:text-foreground">
                        {value}
                      </span>
                      <div
                        className={cn("w-full origin-bottom animate-grow-y rounded-t", value > 0 ? s.colorClass : "bg-muted")}
                        style={{
                          height: `${Math.max(3, Math.round((value / max) * 128))}px`,
                          animationDelay: `${Math.min(gi * series.length + si, 12) * 30}ms`,
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="flex min-w-max gap-6 px-1 pt-2 sm:min-w-0">
          {data.map((group) => (
            <div key={group.label} className="min-w-24 flex-1 truncate text-center text-xs font-medium">
              {group.href ? (
                <Link href={group.href} className="hover:text-primary hover:underline">
                  {group.label}
                </Link>
              ) : (
                group.label
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
