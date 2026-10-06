import { BUSINESS_TIMEZONE } from "@/lib/domain";

// Calendar helpers in business time (IST). Dates are "YYYY-MM-DD" strings,
// the same shape as leads.renewal_date, so they compare as strings.

const IST_OFFSET = "+05:30";

/** Today's date in business time, as YYYY-MM-DD. */
export function todayInBusinessTz(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Adds whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `date` (negative when `date` is earlier). */
export function daysBetween(from: string, date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Start of a business-time day as an ISO timestamp. */
export function startOfBusinessDay(date: string): string {
  return new Date(`${date}T00:00:00${IST_OFFSET}`).toISOString();
}

/** Combines a date and HH:mm in business time into an ISO timestamp. */
export function businessDateTimeToIso(date: string, time: string): string {
  return new Date(`${date}T${time || "10:00"}:00${IST_OFFSET}`).toISOString();
}

/** Business-time date of a timestamp, as YYYY-MM-DD. */
export function businessDateOf(timestamp: string | Date): string {
  return todayInBusinessTz(new Date(timestamp));
}

/** "05 Oct 2026" */
export function formatDate(date: string | null | undefined): string {
  if (!date) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(`${date.slice(0, 10)}T00:00:00Z`));
}

/** "05 Oct, 14:30" in business time. */
export function formatDateTime(timestamp: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BUSINESS_TIMEZONE,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp));
}

/** "14:30" in business time. */
export function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BUSINESS_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp));
}

export type Urgency = "overdue" | "today" | "week" | "month" | "later";

/** How close a renewal date is, for colour coding. */
export function renewalUrgency(date: string, today: string = todayInBusinessTz()): Urgency {
  const days = daysBetween(today, date);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= 7) return "week";
  if (days <= 30) return "month";
  return "later";
}

/** "Today", "Tomorrow", "in 12 days", "3 days ago". */
export function relativeDays(date: string, today: string = todayInBusinessTz()): string {
  const days = daysBetween(today, date);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/** Current time in ms. Server pages render per request, so reading the clock there is intended. */
export function nowMs(): number {
  return Date.now();
}

/** "05 Oct 2026, 14:30" in business time, the note timestamp format. */
export function formatNoteTimestamp(timestamp: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BUSINESS_TIMEZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")}`;
}
