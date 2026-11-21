import type { LeadStatus } from "@/lib/database.types";
import { addDays, addYears } from "@/lib/dates";

// Annual renewal rollover by status. A lost client's renewal date moves on a
// year so the team re-approaches them next year, and a term life policy that
// renews itself (Auto Renewed) moves on a year each time its date passes. The
// person closing the lead confirms or edits the date; moves that skip the
// dialog (the board, the edit form) roll it on the server.
//
// Closed Won is different: its next renewal date is the end date of the
// policy that was uploaded and confirmed (src/server/data/policies.ts), so
// the status alone never moves it.

/** Statuses that move the renewal date on a year when a lead takes them. */
export const CYCLE_CLOSING_STATUSES: readonly LeadStatus[] = ["Auto Renewed", "Closed Lost"];

/**
 * A renewal date further ahead than this is already next cycle's date, so
 * closing the lead leaves it alone (no double roll when someone fixes the
 * status from Auto Renewed to Closed Lost, or set the new date by hand first).
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
