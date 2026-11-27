import "server-only";

import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import { addDays, formatDate, todayInBusinessTz } from "@/lib/dates";
import { LOST_STATUS } from "@/lib/domain";

import { leadNotes, leads, notifications, profiles } from "../db/schema";
import { WITHDRAWN_MARKER } from "./app-leads";
import type { DataContext } from "./context";
import { leadChangeStatements, runLeadBatch, type Lead } from "./leads";

// Win-back: a lost client comes back. When a lead is lost, its renewal date
// moves on a year (src/lib/renewal-rollover.ts). This many days before that
// next renewal, the cron reopens the lead as a Prospect of type Renewal, so the
// countdown reminders reach its agent again and the team can quote for the
// new policy year. Clients who asked not to be contacted, and deceased
// clients, are never reopened.

/** Days before the next renewal date that a lost lead is reopened. */
export const WIN_BACK_DAYS = 60;

/** Leads reopened per cron run, to keep one run's CPU small. */
export const WIN_BACK_BATCH = 50;

/** Lost leads that must stay closed. */
export function isWinBackBlocked(lead: Pick<Lead, "lost_reason" | "lost_reason_detail" | "notes">): boolean {
  if (lead.lost_reason === "Client Deceased") return true;
  if (lead.notes.includes(WITHDRAWN_MARKER)) return true;
  return /do not (call|contact|message)|withdrew consent|dnc\b/i.test(lead.lost_reason_detail);
}

/** The note written on a reopened lead, so the agent knows its story. */
export function winBackNote(lead: Pick<Lead, "lost_reason" | "lost_reason_detail" | "renewal_date">): string {
  const reason = [lead.lost_reason, lead.lost_reason_detail].filter(Boolean).join(": ");
  return (
    `[Win-back] This client was Closed Lost${reason ? ` (${reason})` : ""}. ` +
    `Their next renewal is on ${formatDate(lead.renewal_date ?? "")}, so the lead is open again as a Prospect. ` +
    "Check what changed and offer a fresh quote."
  ).slice(0, 5000);
}

/**
 * Reopens lost leads whose next renewal is at most WIN_BACK_DAYS away (and not
 * passed): status Prospect, type Renewal, lost reason cleared (it stays in the
 * note and the audit log). Their owner, or every active admin when the lead
 * has no active owner, gets one bell message per run. Idempotent: a reopened
 * lead is no longer Closed Lost. Returns how many leads were reopened.
 */
export async function winBackLostLeads(ctx: DataContext, at: Date = new Date(), limit = WIN_BACK_BATCH): Promise<number> {
  const today = todayInBusinessTz(at);
  const [candidates, team] = await Promise.all([
    ctx.db
      .select()
      .from(leads)
      .where(and(eq(leads.status, LOST_STATUS), gte(leads.renewal_date, today), lte(leads.renewal_date, addDays(today, WIN_BACK_DAYS))))
      .orderBy(asc(leads.renewal_date), asc(leads.id))
      .limit(limit * 2),
    ctx.db.select({ id: profiles.id, role: profiles.role, is_active: profiles.is_active }).from(profiles),
  ]);
  const rows = candidates.filter((lead) => !isWinBackBlocked(lead)).slice(0, limit);
  if (rows.length === 0) return 0;

  const active = new Set(team.filter((p) => p.is_active).map((p) => p.id));
  const admins = team.filter((p) => p.is_active && p.role === "ADMIN").map((p) => p.id);

  const statements: BatchItem<"sqlite">[] = [];
  const perPerson = new Map<string, string[]>();
  for (const before of rows) {
    const changes = await leadChangeStatements(
      ctx,
      null,
      before,
      { status: "Prospect", type: "Renewal", lost_reason: "", lost_reason_detail: "" },
      { notifyOwner: false },
    );
    if (changes.length === 0) continue;
    statements.push(
      ...changes,
      ctx.db.insert(leadNotes).values({ lead_id: before.id, agent_id: null, agent_name: "CapitUp LMS", content: winBackNote(before) }),
    );
    const owner = before.assigned_agent_id;
    for (const person of owner && active.has(owner) ? [owner] : admins) {
      perPerson.set(person, [...(perPerson.get(person) ?? []), before.client_name]);
    }
  }
  for (const [user_id, names] of perPerson) {
    const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? ` and ${names.length - 5} more` : "");
    statements.push(
      ctx.db.insert(notifications).values({
        user_id,
        kind: "other",
        title: (names.length === 1 ? `Win-back: ${names[0]} renews soon` : `Win-back: ${names.length} lost clients renew soon`).slice(0, 300),
        body: `${shown} ${names.length === 1 ? "was" : "were"} Closed Lost last time and ${names.length === 1 ? "is" : "are"} open again as Prospect. Their renewal is within ${WIN_BACK_DAYS} days.`.slice(0, 2000),
        ...(names.length === 1 ? { lead_id: rows.find((r) => r.client_name === names[0])?.id ?? null } : {}),
      }),
    );
  }
  await runLeadBatch(ctx, statements);
  return rows.length;
}
