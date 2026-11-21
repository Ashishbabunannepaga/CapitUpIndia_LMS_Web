// Lead and client codes.
//
// * Lead code "LEAD-0042": every lead, from its id, so it never changes.
// * Client code "CAP-CLI-2026-0007": a lead that became a client (Closed Won
//   or Auto Renewed) gets a permanent client number (0007, never reused);
//   the year is the year its current policy started. Next year's policy keeps
//   the number and moves the year on (CAP-CLI-2027-0007), so every policy
//   year of a client has its own code and the same client is still easy to
//   find. Each year's code is kept on its Policy history row.

export const LEAD_CODE_PREFIX = "LEAD-";
export const CLIENT_CODE_PREFIX = "CAP-CLI-";

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

export function leadCode(id: number): string {
  return `${LEAD_CODE_PREFIX}${pad(id)}`;
}

export function clientCode(clientNo: number, year: number): string {
  return `${CLIENT_CODE_PREFIX}${year}-${pad(clientNo)}`;
}

/** The year a policy cycle counts as: the year its policy starts (or of `fallbackDate`). */
export function policyYear(policyStart: string | null | undefined, fallbackDate: string): number {
  return Number((policyStart || fallbackDate).slice(0, 4));
}

/**
 * What a search term means as a code: a lead id ("LEAD-0042", "lead42") or
 * a client number ("CAP-CLI-2026-0007", "CAP-CLI-0007", "cli-7"), or null.
 */
export function parseCode(term: string): { leadId: number } | { clientNo: number } | null {
  const t = term.trim().toUpperCase().replace(/[\s_]/g, "-");
  const lead = /^LEAD-?0*(\d{1,9})$/.exec(t);
  if (lead) return { leadId: Number(lead[1]) };
  const client = /^(?:CAP-)?CLI(?:ENT)?-(?:\d{4}-)?0*(\d{1,9})$/.exec(t);
  if (client) return { clientNo: Number(client[1]) };
  return null;
}
