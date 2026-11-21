"use client";

import { useState, useTransition } from "react";
import { CalendarClock, CalendarPlus, Loader2, X } from "lucide-react";
import { Dialog } from "radix-ui";

import { rollForwardClosedLeads, setRenewalDate } from "@/app/(app)/leads/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { LeadStatus } from "@/lib/database.types";
import { formatDate } from "@/lib/dates";
import { safeAction } from "@/lib/safe-action";

const WHY: Record<string, string> = {
  "Auto Renewed": "The policy renews itself, so this year's renewal is done. Next year's renewal moves to the date below.",
  "Closed Lost": "This year's renewal is lost. The date moves on a year so the team sees the client again next year and can re-approach.",
};

/**
 * Asks the person closing a lead to confirm (or correct) the next renewal
 * date before the status changes. Controlled by the status menu.
 */
export function VerifyRenewalDialog({
  open,
  status,
  currentDate,
  suggestedDate,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  status: LeadStatus;
  currentDate: string | null;
  suggestedDate: string;
  /** The date to save, or the current date to keep it as it is. */
  onConfirm: (renewalDate: string) => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(suggestedDate);
  const [lastSuggested, setLastSuggested] = useState(suggestedDate);
  if (suggestedDate !== lastSuggested) {
    setLastSuggested(suggestedDate);
    setDate(suggestedDate);
  }
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? null : onCancel())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-in bg-black/40 fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-card p-5 shadow-lift">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="space-y-1">
              <Dialog.Title className="font-semibold">Verify the next renewal date</Dialog.Title>
              <Dialog.Description className="text-sm text-muted-foreground">{WHY[status]}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Cancel">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) onConfirm(date);
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="next-renewal-date">Next renewal date</Label>
              <Input
                id="next-renewal-date"
                type="date"
                required
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {currentDate ? `This year's date was ${formatDate(currentDate)}. ` : null}
                The countdown reminders (T-30 days to T-5 minutes) are rebuilt for this date, and it shows on that month&apos;s
                calendar instead of as overdue.
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {currentDate ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => onConfirm(currentDate)}>
                  Keep {formatDate(currentDate)}
                </Button>
              ) : null}
              <Button type="submit" size="sm" disabled={!valid}>
                <CalendarClock />
                Mark {status} and save date
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * On a closed lead whose renewal is near or past: move it on to next year
 * (after confirming the date) without changing the status (Closed Lost and
 * Auto Renewed; a Closed Won client moves on by uploading next year's policy).
 */
export function RollRenewalButton({
  leadId,
  status,
  currentDate,
  suggestedDate,
}: {
  leadId: number;
  status: LeadStatus;
  currentDate: string;
  suggestedDate: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setOpen(true)}>
        {pending ? <Loader2 className="animate-spin" /> : <CalendarPlus />}
        Move to next year
      </Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <VerifyRenewalDialog
        open={open}
        status={status}
        currentDate={currentDate}
        suggestedDate={suggestedDate}
        onCancel={() => setOpen(false)}
        onConfirm={(date) => {
          setOpen(false);
          if (date === currentDate) return;
          setError(null);
          startTransition(async () => {
            const result = await safeAction(() => setRenewalDate(leadId, date));
            if (!result.ok) setError(result.error);
          });
        }}
      />
    </div>
  );
}

/** Admins: the one-off catch-up for leads closed before the rollover existed. */
export function RollForwardBanner({ count }: { count: number }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div
      role="note"
      className="mb-4 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <CalendarClock className="mt-0.5 size-4 shrink-0" />
        <div>
          <p className="font-semibold">
            {count} closed lead{count === 1 ? " still has" : "s still have"} last cycle&apos;s renewal date
          </p>
          <p className="text-amber-800/80 dark:text-amber-100/80">
            Closed Lost and Auto Renewed leads move to next year&apos;s renewal date so they reappear on next year&apos;s
            calendar. Each lead keeps its day and month, and the passed date stays on the calendar as done. Closed Won clients
            move on when next year&apos;s policy is uploaded.
          </p>
          {message ? (
            <p role="status" className={message.ok ? "mt-1 font-medium" : "mt-1 font-medium text-destructive"}>
              {message.text}
            </p>
          ) : null}
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        disabled={pending}
        className="shrink-0"
        onClick={() => {
          if (!window.confirm(`Move up to 100 closed leads to next year's renewal date now?`)) return;
          setMessage(null);
          startTransition(async () => {
            const result = await safeAction(() => rollForwardClosedLeads());
            setMessage(result.ok ? { ok: true, text: result.message ?? "Done." } : { ok: false, text: result.error });
          });
        }}
      >
        {pending ? <Loader2 className="animate-spin" /> : <CalendarPlus />}
        Move them to next year
      </Button>
    </div>
  );
}
