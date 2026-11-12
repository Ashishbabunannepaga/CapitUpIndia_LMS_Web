import "server-only";

import { eq, sql, type SQL } from "drizzle-orm";

import { DEFAULT_STALE_DAYS, DONE_STATUSES } from "@/lib/domain";

import { appSettings, leads } from "../db/schema";
import { assertAdmin, type Actor } from "./actor";
import type { DataContext } from "./context";
import { InvalidInputError } from "./errors";

// Stale leads: open leads (not Closed Won or Closed Lost) with no activity for
// longer than the admins' threshold (app_settings "stale_lead_days", default 7).
// Activity is the latest of: the lead saved (edits, status changes and
// reassignments all update it), a note, a Call/WhatsApp/Email press, and a
// task or meeting on the lead created or ticked off. Everything is worked out
// in SQL from rows that already exist, so nothing new is written to flag a lead.

export const STALE_SETTING = "stale_lead_days";
export const MIN_STALE_DAYS = 1;
export const MAX_STALE_DAYS = 365;

/** The threshold in days, read inside a query (so callers need no extra round trip). */
const staleDays = sql`coalesce((select cast(${appSettings.value} as integer) from ${appSettings} where ${appSettings.key} = ${STALE_SETTING}), ${DEFAULT_STALE_DAYS})`;

/** ISO timestamp: activity before this is stale. */
const staleCutoff = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ${staleDays} || ' days')`;

/** The lead's latest activity, as an ISO timestamp, for a query over `leads`. */
export const lastActivityAt: SQL<string> = sql<string>`max(${leads.updated_at},
  coalesce((select max(n.created_at) from lead_notes n where n.lead_id = ${leads.id}), ''),
  coalesce((select max(c.created_at) from lead_contact_logs c where c.lead_id = ${leads.id}), ''),
  coalesce((select max(max(e.created_at, coalesce(e.completed_at, ''))) from events e
    where e.lead_id = ${leads.id} and e.is_system_generated = 0), ''))`;

const openLead = sql`${leads.status} not in (${sql.join(
  DONE_STATUSES.map((s) => sql`${s}`),
  sql`, `,
)})`;

/** True for an open lead whose latest activity is older than the threshold. */
export const isStale: SQL<boolean> = sql<boolean>`(${openLead} and ${lastActivityAt} < ${staleCutoff})`;

/** The threshold admins set, in days. */
export async function getStaleDays(ctx: DataContext): Promise<number> {
  const row = await ctx.db.query.appSettings.findFirst({ where: eq(appSettings.key, STALE_SETTING) });
  const days = Number(row?.value);
  return Number.isInteger(days) && days >= MIN_STALE_DAYS ? days : DEFAULT_STALE_DAYS;
}

/** Sets the stale threshold. Admins only. */
export async function setStaleDays(ctx: DataContext, actor: Actor, days: number): Promise<void> {
  assertAdmin(actor);
  if (!Number.isInteger(days) || days < MIN_STALE_DAYS || days > MAX_STALE_DAYS) {
    throw new InvalidInputError(`Pick a whole number of days from ${MIN_STALE_DAYS} to ${MAX_STALE_DAYS}.`);
  }
  const stamp = new Date().toISOString();
  await ctx.db
    .insert(appSettings)
    .values({
      key: STALE_SETTING,
      value: days,
      description: "Days without activity before an open lead is flagged stale.",
      updated_at: stamp,
      updated_by: actor.id,
    })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: days, updated_at: stamp, updated_by: actor.id } });
}
