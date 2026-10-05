import { AlertTriangle, CalendarClock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { LeadStatus } from "@/lib/database.types";
import { formatDate, relativeDays, renewalUrgency, todayInBusinessTz, type Urgency } from "@/lib/dates";
import { STATUS_STYLES } from "@/lib/domain";
import { cn } from "@/lib/utils";

export function StatusBadge({ status, className }: { status: LeadStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn(STATUS_STYLES[status].badge, className)}>
      <span className={cn("size-1.5 rounded-full", STATUS_STYLES[status].dot)} />
      {status}
    </Badge>
  );
}

export function DuplicateBadge({ label, className }: { label?: string; className?: string }) {
  return (
    <Badge
      variant="outline"
      title={label || "Another record exists for this company"}
      className={cn("border-red-200 bg-red-50 text-red-700", className)}
    >
      <AlertTriangle />
      Duplicate
    </Badge>
  );
}

const URGENCY_STYLES: Record<Urgency, string> = {
  overdue: "text-urgent font-semibold",
  today: "text-urgent font-semibold",
  week: "text-warning font-semibold",
  month: "text-foreground",
  later: "text-muted-foreground",
};

/** Renewal date with a colour-coded "in N days" hint. */
export function RenewalDate({
  date,
  closed = false,
  compact = false,
}: {
  date: string | null;
  closed?: boolean;
  compact?: boolean;
}) {
  if (!date) return <span className="text-muted-foreground">—</span>;
  const today = todayInBusinessTz();
  const urgency = renewalUrgency(date, today);
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", !closed && URGENCY_STYLES[urgency])}>
      {!compact && urgency !== "later" && !closed ? <CalendarClock className="size-3.5" /> : null}
      {formatDate(date)}
      {!closed && urgency !== "later" ? (
        <span className="text-xs font-normal opacity-80">({relativeDays(date, today)})</span>
      ) : null}
    </span>
  );
}
