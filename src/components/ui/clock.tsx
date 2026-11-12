"use client";

import { useId, useState, useSyncExternalStore } from "react";

import { NativeSelect } from "@/components/ui/native-select";
import {
  CLOCK_STORAGE_KEY,
  DEFAULT_CLOCK_FORMAT,
  formatClockTime,
  from12Hour,
  isClockFormat,
  parseHhmm,
  to12Hour,
  toHhmm,
  type ClockFormat,
} from "@/lib/clock";
import { cn } from "@/lib/utils";

// The 12h/24h preference is kept in this browser (localStorage) and shared
// by every time field and time label on the page: flipping one switch flips
// them all. The server always renders 12h (the default); a browser set to
// 24h switches right after it loads.

const CHANGE_EVENT = "capitup:clock-format";

function readFormat(): ClockFormat {
  try {
    const stored = window.localStorage.getItem(CLOCK_STORAGE_KEY);
    return isClockFormat(stored) ? stored : DEFAULT_CLOCK_FORMAT;
  } catch {
    return DEFAULT_CLOCK_FORMAT; // Storage blocked (private mode): stay on the default.
  }
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === CLOCK_STORAGE_KEY) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useClockFormat(): [ClockFormat, (format: ClockFormat) => void] {
  const format = useSyncExternalStore(subscribe, readFormat, () => DEFAULT_CLOCK_FORMAT);
  const setFormat = (next: ClockFormat) => {
    try {
      window.localStorage.setItem(CLOCK_STORAGE_KEY, next);
    } catch {
      // Not saved, but this page still switches.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };
  return [format, setFormat];
}

/** A small 12h | 24h switch. */
export function ClockToggle({ className }: { className?: string }) {
  const [format, setFormat] = useClockFormat();
  return (
    <div
      role="radiogroup"
      aria-label="Clock format"
      className={cn("inline-flex h-8 shrink-0 items-center rounded-full border bg-muted p-0.5 text-[11px] font-medium", className)}
    >
      {(["12h", "24h"] as const).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={format === option}
          onClick={() => setFormat(option)}
          className={cn(
            "h-full rounded-full px-2.5 transition-colors",
            format === option ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

/**
 * A time picker that follows the 12h/24h switch. It submits `name` as 24-hour
 * "HH:mm" either way, so the server never sees the display format.
 */
export function TimeField({
  name,
  defaultValue = "10:00",
  label = "Time",
  className,
}: {
  name: string;
  defaultValue?: string;
  label?: string;
  className?: string;
}) {
  const [format] = useClockFormat();
  const id = useId();
  const initial = parseHhmm(defaultValue) ?? { hours: 10, minutes: 0 };
  const [hours, setHours] = useState(initial.hours);
  const [minutes, setMinutes] = useState(initial.minutes);
  const { hour, period } = to12Hour(hours);
  // Keep a minute that is not a multiple of 5 (from an existing task) selectable.
  const minuteOptions = MINUTES.includes(minutes) ? MINUTES : [...MINUTES, minutes].sort((a, b) => a - b);
  const pad = (n: number) => String(n).padStart(2, "0");
  const select = "w-[4.25rem] shrink-0 tabular-nums";

  return (
    <fieldset className={cn("flex min-w-0 items-center gap-1 border-0 p-0", className)} aria-label={label}>
      <input type="hidden" name={name} value={toHhmm(hours, minutes)} />
      {format === "12h" ? (
        <NativeSelect
          id={`${id}-h`}
          aria-label={`${label}: hour`}
          value={hour}
          onChange={(e) => setHours(from12Hour(Number(e.target.value), period))}
          className={select}
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </NativeSelect>
      ) : (
        <NativeSelect
          id={`${id}-h`}
          aria-label={`${label}: hour`}
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
          className={select}
        >
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {pad(h)}
            </option>
          ))}
        </NativeSelect>
      )}
      <span aria-hidden="true" className="text-muted-foreground">
        :
      </span>
      <NativeSelect aria-label={`${label}: minutes`} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={select}>
        {minuteOptions.map((m) => (
          <option key={m} value={m}>
            {pad(m)}
          </option>
        ))}
      </NativeSelect>
      {format === "12h" ? (
        <NativeSelect
          aria-label={`${label}: AM or PM`}
          value={period}
          onChange={(e) => setHours(from12Hour(hour, e.target.value as "AM" | "PM"))}
          className="w-[4.75rem] shrink-0"
        >
          <option value="AM">AM</option>
          <option value="PM">PM</option>
        </NativeSelect>
      ) : null}
    </fieldset>
  );
}

/** A timestamp's time of day (India time) in the chosen format. */
export function ClockTime({ timestamp }: { timestamp: string }) {
  const [format] = useClockFormat();
  return <time dateTime={timestamp}>{formatClockTime(timestamp, format)}</time>;
}
