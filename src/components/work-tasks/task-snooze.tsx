"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BellOff, BellRing } from "lucide-react";

import { snoozeWorkTaskAction } from "@/app/(app)/tasks/actions";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import { safeAction } from "@/lib/safe-action";

const CHOICES: { label: string; value: number | "tomorrow" }[] = [
  { label: "1 hour", value: 60 },
  { label: "3 hours", value: 180 },
  { label: "Tomorrow 9 AM", value: "tomorrow" },
];

/** "I'm on it": the assignee pauses reminders, nudges and escalation for a while. */
export function SnoozeButtons({ taskId, snoozedUntil: until }: { taskId: number; snoozedUntil: string | null }) {
  const router = useRouter();
  const [now] = useState(() => Date.now());
  const snoozedUntil = until && Date.parse(until) > now ? until : null;
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function snooze(value: number | "tomorrow") {
    setError(null);
    start(async () => {
      const result = await safeAction(() => snoozeWorkTaskAction(taskId, value));
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <section className="surface space-y-2 p-4">
      <h2 className="text-sm font-medium">I&apos;m on it</h2>
      {snoozedUntil ? (
        <>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <BellOff className="size-3.5" /> Reminders paused until {formatDateTime(snoozedUntil)}.
          </p>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => snooze(0)}>
            <BellRing className="size-4" /> Turn reminders back on
          </Button>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">Pause reminders and nudges for:</p>
          <div className="flex flex-wrap gap-2">
            {CHOICES.map((c) => (
              <Button key={c.label} size="sm" variant="outline" disabled={pending} onClick={() => snooze(c.value)}>
                {c.label}
              </Button>
            ))}
          </div>
        </>
      )}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
