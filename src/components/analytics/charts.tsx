import Link from "next/link";

import { formatCount } from "@/lib/analytics";
import { cn } from "@/lib/utils";

// Small server-rendered charts: no chart library, no client JavaScript.

export function StatCard({
  label,
  value,
  hint,
  href,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
  tone?: "default" | "urgent" | "warning" | "success";
}) {
  const body = (
    <>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          tone === "urgent" && "text-urgent",
          tone === "warning" && "text-warning",
          tone === "success" && "text-success",
        )}
      >
        {typeof value === "number" ? formatCount(value) : value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </>
  );
  const className = "rounded-xl border bg-card p-4 shadow-sm";
  return href ? (
    <Link href={href} className={cn(className, "block transition-shadow hover:shadow-md")}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

export function Panel({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border bg-card shadow-sm", className)}>
      <header className="border-b px-5 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export type BarDatum = { label: string; value: number; href?: string; colorClass?: string; valueLabel?: string };

/** Horizontal bars, sized against the largest value. */
export function BarList({ data, emptyText = "No data yet." }: { data: BarDatum[]; emptyText?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0 || data.every((d) => d.value === 0)) {
    return <p className="py-2 text-sm text-muted-foreground">{emptyText}</p>;
  }
  return (
    <ul className="space-y-2.5">
      {data.map((item) => (
        <li key={item.label} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            {item.href ? (
              <Link href={item.href} className="truncate hover:text-primary hover:underline">
                {item.label}
              </Link>
            ) : (
              <span className="truncate">{item.label}</span>
            )}
            <span className="shrink-0 font-medium tabular-nums">{item.valueLabel ?? formatCount(item.value)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full", item.colorClass ?? "bg-primary")}
              style={{ width: `${Math.round((item.value / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Monthly columns, for renewals and leads created. */
export function MonthBars({ data, colorClass = "bg-primary" }: { data: { month: string; count: number }[]; colorClass?: string }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const label = (month: string) =>
    new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
  return (
    <div className="flex items-end gap-1.5" role="img" aria-label={data.map((d) => `${label(d.month)}: ${d.count}`).join(", ")}>
      {data.map((item) => (
        <div key={item.month} className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <span className="text-[10px] tabular-nums text-muted-foreground">{item.count || ""}</span>
          <div
            className={cn("w-full rounded-t", item.count > 0 ? colorClass : "bg-muted")}
            style={{ height: `${Math.max(2, Math.round((item.count / max) * 96))}px` }}
          />
          <span className="truncate text-[10px] text-muted-foreground">{label(item.month)}</span>
        </div>
      ))}
    </div>
  );
}
