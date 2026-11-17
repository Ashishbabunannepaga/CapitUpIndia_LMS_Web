import type { LeadStatus } from "@/lib/database.types";
import { addDays, addYears } from "@/lib/dates";
import { DONE_STATUSES } from "@/lib/domain";

// Annual renewal rollover. When a lead is closed (Closed Won, Renewed or
// Closed Lost), this year's policy cycle is over: the renewal date moves to
// next year so the lead stops showing as overdue and its countdown appears on
// next year's calendar (won or renewed clients renew again; lost ones are
// approached again). The person closing the lead confirms or edits the date;
// moves that skip the dialog (the board, the edit form) roll it on the server.

/** Statuses that close this year's policy cycle. */
export const CYCLE_CLOSING_STATUSES: readonly LeadStatus[] = DONE_STATUSES;

/**
 * A renewal date further ahead than this is already next cycle's date, so
 * closing the lead leaves it alone (no double roll when someone fixes the
 * status from Closed Won to Renewed, or set the new date by hand first).
 */
export const ROLLOVER_WINDOW_DAYS = 90;

export function closesCycle(status: string): boolean {
  return (CYCLE_CLOSING_STATUSES as readonly string[]).includes(status);
}

/**
 * The next renewal date after closing a cycle that renews on `renewalDate`:
 * one year on, and further whole years if that is still not after today (an
 * old record left overdue for more than a year). Null when there is nothing
 * to roll: no date, or a date already beyond the rollover window.
 */
export function nextRenewalDate(renewalDate: string | null | undefined, today: string): string | null {
  if (!renewalDate) return null;
  if (renewalDate > addDays(today, ROLLOVER_WINDOW_DAYS)) return null;
  let years = 1;
  let next = addYears(renewalDate, years);
  while (next <= today) next = addYears(renewalDate, ++years);
  return next;
}

/**
 * The date a status change should roll the renewal to, or null to keep it:
 * only a move into a closing status from a different status rolls.
 */
export function rolloverForStatusChange(
  lead: { status: string; renewal_date: string | null },
  nextStatus: string,
  today: string,
): string | null {
  if (nextStatus === lead.status || !closesCycle(nextStatus)) return null;
  return nextRenewalDate(lead.renewal_date, today);
}
