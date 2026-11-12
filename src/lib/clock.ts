import { BUSINESS_TIMEZONE } from "@/lib/domain";

// 12-hour or 24-hour clock for times people type and read. The choice is a
// per-browser preference (localStorage, see src/components/ui/clock.tsx);
// what is stored and sent to the server is always 24-hour "HH:mm".

export type ClockFormat = "12h" | "24h";
export const DEFAULT_CLOCK_FORMAT: ClockFormat = "12h";
export const CLOCK_STORAGE_KEY = "capitup.clockFormat";

export function isClockFormat(value: unknown): value is ClockFormat {
  return value === "12h" || value === "24h";
}

/** "HH:mm" (24-hour) → its parts, or null when it is not a valid time. */
export function parseHhmm(value: string): { hours: number; minutes: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 24-hour hours → the 12-hour hour (1-12) and AM/PM. */
export function to12Hour(hours: number): { hour: number; period: "AM" | "PM" } {
  return { hour: hours % 12 === 0 ? 12 : hours % 12, period: hours < 12 ? "AM" : "PM" };
}

/** A 12-hour hour (1-12) and AM/PM → 24-hour hours. */
export function from12Hour(hour: number, period: "AM" | "PM"): number {
  return (hour % 12) + (period === "PM" ? 12 : 0);
}

export function toHhmm(hours: number, minutes: number): string {
  return `${pad(hours)}:${pad(minutes)}`;
}

/** "14:05" → "2:05 PM" (12h) or "14:05" (24h). */
export function formatHhmm(value: string, format: ClockFormat): string {
  const time = parseHhmm(value);
  if (!time) return value;
  if (format === "24h") return toHhmm(time.hours, time.minutes);
  const { hour, period } = to12Hour(time.hours);
  return `${hour}:${pad(time.minutes)} ${period}`;
}

const businessTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** A timestamp's time of day in business time (India), in the chosen format. */
export function formatClockTime(timestamp: string, format: ClockFormat): string {
  return formatHhmm(businessTime.format(new Date(timestamp)), format);
}

/** A timestamp's business-time "HH:mm", for filling a time field. */
export function businessHhmm(timestamp: string): string {
  return businessTime.format(new Date(timestamp));
}
