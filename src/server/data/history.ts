import "server-only";

import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";

import { auditLogs, events, leadContactLogs, leadNotes, leads, profiles } from "../db/schema";
import { assertAdmin, isAdmin, type Actor } from "./actor";
import type { DataContext } from "./context";
import { InvalidInputError } from "./errors";

// A lead's history and the admins' audit log. Both read rows that already
// exist: every lead write leaves an audit_logs row with the row before and
// after (in the same D1 batch as the write, see leads.ts), and notes, tasks
// and contact presses are their own rows. Nothing extra is recorded for them.

export type FieldChange = { field: string; label: string; from: string; to: string };

/** Lead fields worth showing in a change, with how people call them. */
const FIELD_LABELS: Record<string, string> = {
  client_name: "Company",
  status: "Status",
  assigned_agent_id: "Assigned agent",
  type: "New / renewal",
  business_type: "Corporate / retail",
  policy_product: "Product",
  sub_product_name: "Sub-product",
  renewal_date: "Renewal date",
  poc_name: "Primary POC",
  poc_designation: "Primary POC designation",
  poc_contact_number: "Primary POC phone",
  poc_email_id: "Primary POC email",
  poc2_name: "Secondary POC",
  poc2_designation: "Secondary POC designation",
  poc2_contact_number: "Secondary POC phone",
  poc2_email_id: "Secondary POC email",
  address: "Address",
  relationship_manager: "RM",
  notes: "Lead notes",
  is_duplicate: "Duplicate flag",
  visiting_card_path: "Visiting card",
};

const MAX_VALUE = 300;

type Row = Record<string, unknown> | null;

function show(field: string, value: unknown, names: Map<string, string>): string {
  if (value === null || value === undefined || value === "") return field === "assigned_agent_id" ? "Unassigned" : "(empty)";
  if (field === "assigned_agent_id") return names.get(String(value)) ?? "a former user";
  if (field === "is_duplicate") return value === true || value === 1 ? "Flagged" : "Cleared";
  if (field === "visiting_card_path") return "Attached";
  const text = String(value);
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}

/** What changed between two lead rows, field by field, in a fixed order. */
export function diffLead(before: Row, after: Row, names: Map<string, string> = new Map()): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, label] of Object.entries(FIELD_LABELS)) {
    const a = before?.[field] ?? null;
    const b = after?.[field] ?? null;
    if ((a ?? "") === (b ?? "") || (field === "is_duplicate" && Boolean(a) === Boolean(b))) continue;
    if (!before && (b === null || b === "" || b === false || (field === "poc_designation" && b === "poc"))) continue;
    changes.push({ field, label, from: before ? show(field, a, names) : "", to: after ? show(field, b, names) : "" });
  }
  return changes;
}

async function profileNames(ctx: DataContext): Promise<Map<string, string>> {
  const rows = await ctx.db.select({ id: profiles.id, name: profiles.full_name }).from(profiles);
  return new Map(rows.map((r) => [r.id, r.name]));
}

// --- A lead's history ------------------------------------------------------

export type HistoryKind =
  | "created"
  | "status"
  | "assigned"
  | "edited"
  | "tags"
  | "note"
  | "task_created"
  | "task_done"
  | "task_reopened"
  | "task_moved"
  | "contact"
  | "deleted";

export type HistoryItem = {
  at: string;
  kind: HistoryKind;
  /** Who did it; "System" for imports and server jobs. */
  who: string;
  /** One line about what happened. */
  summary: string;
  changes: FieldChange[];
};

const CHANNELS: Record<string, string> = { call: "Called", whatsapp: "Sent a WhatsApp", email: "Sent an email" };

function leadAuditItem(row: typeof auditLogs.$inferSelect, names: Map<string, string>): HistoryItem | null {
  const who = row.actor_id ? (names.get(row.actor_id) ?? "A former user") : "System";
  const before = row.old_data as Row;
  const after = row.new_data as Row;
  if (row.action === "INSERT") {
    const owner = after?.assigned_agent_id ? names.get(String(after.assigned_agent_id)) : null;
    return { at: row.created_at, kind: "created", who, summary: owner ? `Created the lead for ${owner}` : "Created the lead", changes: [] };
  }
  if (row.action === "DELETE") return { at: row.created_at, kind: "deleted", who, summary: "Deleted the lead", changes: [] };
  const changes = diffLead(before, after, names);
  if (changes.length === 0) return null;
  const status = changes.find((c) => c.field === "status");
  const owner = changes.find((c) => c.field === "assigned_agent_id");
  if (status && changes.length === 1) return { at: row.created_at, kind: "status", who, summary: `Status ${status.from} → ${status.to}`, changes };
  if (owner && changes.length === 1) return { at: row.created_at, kind: "assigned", who, summary: `Assigned ${owner.from} → ${owner.to}`, changes };
  return {
    at: row.created_at,
    kind: status ? "status" : owner ? "assigned" : "edited",
    who,
    summary: `Edited ${changes.map((c) => c.label.toLowerCase()).join(", ")}`,
    changes,
  };
}

function eventAuditItem(row: typeof auditLogs.$inferSelect, names: Map<string, string>): HistoryItem | null {
  const who = row.actor_id ? (names.get(row.actor_id) ?? "A former user") : "System";
  const before = (row.old_data ?? {}) as Record<string, unknown>;
  const after = (row.new_data ?? {}) as Record<string, unknown>;
  const title = String(after.title ?? before.title ?? "a task");
  if ("is_completed" in after && after.is_completed !== before.is_completed) {
    return after.is_completed
      ? { at: row.created_at, kind: "task_done", who, summary: `Completed “${title}”`, changes: [] }
      : { at: row.created_at, kind: "task_reopened", who, summary: `Reopened “${title}”`, changes: [] };
  }
  if (after.event_timestamp && after.event_timestamp !== before.event_timestamp) {
    const snoozed = typeof after.snoozed_days === "number" ? ` (snoozed ${after.snoozed_days} day${after.snoozed_days === 1 ? "" : "s"})` : "";
    return { at: row.created_at, kind: "task_moved", who, summary: `Moved “${title}”${snoozed}`, changes: [] };
  }
  if (after.title !== before.title) return { at: row.created_at, kind: "task_moved", who, summary: `Edited “${title}”`, changes: [] };
  return null;
}

/**
 * Everything that happened to a lead, newest first: created, status changes,
 * reassignments, edits (field by field), tags, notes, tasks and meetings,
 * and Call/WhatsApp/Email presses (AI follow-up drafts included). Anyone who
 * can see the lead sees its history; agents see only their own tasks on it,
 * as on the lead page. Null when the caller cannot see the lead.
 */
export async function leadHistory(ctx: DataContext, actor: Actor, leadId: number, limit = 300): Promise<HistoryItem[] | null> {
  const scope = isAdmin(actor) ? undefined : eq(leads.assigned_agent_id, actor.id);
  const myEvents = isAdmin(actor) ? undefined : eq(events.assigned_agent_id, actor.id);
  const record = String(leadId);
  const [found, leadAudit, eventRows, notes, contacts] = await ctx.db.batch([
    ctx.db.select({ id: leads.id }).from(leads).where(and(eq(leads.id, leadId), scope)).limit(1),
    ctx.db
      .select()
      .from(auditLogs)
      .where(and(inArray(auditLogs.table_name, ["leads", "lead_tags"]), eq(auditLogs.record_id, record)))
      .orderBy(desc(auditLogs.created_at))
      .limit(limit),
    ctx.db
      .select({ id: events.id, title: events.title, kind: events.kind, created_at: events.created_at, created_by: events.created_by })
      .from(events)
      .where(and(eq(events.lead_id, leadId), eq(events.is_system_generated, false), myEvents)),
    ctx.db.select().from(leadNotes).where(eq(leadNotes.lead_id, leadId)).orderBy(desc(leadNotes.created_at)).limit(limit),
    ctx.db.select().from(leadContactLogs).where(eq(leadContactLogs.lead_id, leadId)).orderBy(desc(leadContactLogs.created_at)).limit(limit),
  ]);
  if (found.length === 0) return null;

  // Task completions and moves are audited on the event; only this lead's (visible) events.
  const eventIds = eventRows.map((e) => String(e.id));
  const [eventAudit, names] = await Promise.all([
    eventIds.length === 0
      ? Promise.resolve([] as (typeof auditLogs.$inferSelect)[])
      : ctx.db
          .select()
          .from(auditLogs)
          .where(and(eq(auditLogs.table_name, "events"), inArray(auditLogs.record_id, eventIds.slice(0, 90))))
          .orderBy(desc(auditLogs.created_at))
          .limit(limit),
    profileNames(ctx),
  ]);

  const items: HistoryItem[] = [];
  for (const row of leadAudit) {
    if (row.table_name === "lead_tags") {
      const before = ((row.old_data as Row)?.tags as string[] | undefined) ?? [];
      const after = ((row.new_data as Row)?.tags as string[] | undefined) ?? [];
      items.push({
        at: row.created_at,
        kind: "tags",
        who: row.actor_id ? (names.get(row.actor_id) ?? "A former user") : "System",
        summary: after.length ? `Tags: ${after.join(", ")}` : "Removed all tags",
        changes: [{ field: "tags", label: "Tags", from: before.join(", ") || "(none)", to: after.join(", ") || "(none)" }],
      });
      continue;
    }
    const item = leadAuditItem(row, names);
    if (item) items.push(item);
  }
  for (const row of eventAudit) {
    const item = eventAuditItem(row, names);
    if (item) items.push(item);
  }
  for (const e of eventRows) {
    items.push({
      at: e.created_at,
      kind: "task_created",
      who: e.created_by ? (names.get(e.created_by) ?? "A former user") : "System",
      summary: `Planned ${e.kind === "meeting" ? "a meeting" : "a task"}: “${e.title}”`,
      changes: [],
    });
  }
  for (const n of notes) {
    items.push({ at: n.created_at, kind: "note", who: n.agent_name, summary: n.content, changes: [] });
  }
  for (const c of contacts) {
    items.push({
      at: c.created_at,
      kind: "contact",
      who: c.agent_name,
      summary: `${CHANNELS[c.channel] ?? c.channel}${c.with_draft ? " with an AI follow-up draft" : ""}`,
      changes: [],
    });
  }
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}

// --- Admin audit log -------------------------------------------------------

export type AuditEntry = {
  id: number;
  at: string;
  action: "INSERT" | "UPDATE" | "DELETE";
  actor_id: string | null;
  actor_name: string;
  lead_id: number;
  lead_name: string;
  /** False once the lead is deleted (the name then comes from the log). */
  lead_exists: boolean;
  changes: FieldChange[];
};

export type AuditFilter = {
  actorId?: string;
  leadId?: number;
  field?: string;
  /** ISO timestamps, from inclusive, to exclusive. */
  from?: string;
  to?: string;
  page?: number;
};

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_FIELDS = FIELD_LABELS;

/**
 * Every create, edit and delete of a lead: who, which fields, old and new
 * values, when. Newest first, AUDIT_PAGE_SIZE per page. Admins only.
 */
export async function listLeadAudit(
  ctx: DataContext,
  actor: Actor,
  filter: AuditFilter = {},
): Promise<{ entries: AuditEntry[]; hasMore: boolean }> {
  assertAdmin(actor);
  if (filter.field !== undefined && !Object.hasOwn(FIELD_LABELS, filter.field)) throw new InvalidInputError("Unknown field.");
  const page = Math.min(Math.max(Math.floor(filter.page ?? 1), 1), 10_000);
  const where: (SQL | undefined)[] = [eq(auditLogs.table_name, "leads")];
  if (filter.actorId) where.push(eq(auditLogs.actor_id, filter.actorId));
  if (filter.leadId !== undefined) where.push(eq(auditLogs.record_id, String(filter.leadId)));
  if (filter.from) where.push(sql`${auditLogs.created_at} >= ${filter.from}`);
  if (filter.to) where.push(sql`${auditLogs.created_at} < ${filter.to}`);
  if (filter.field) {
    // json_extract on a fixed, checked key; edits where that field differs (and creates or deletes that set it).
    const path = `$.${filter.field}`;
    where.push(sql`json_extract(${auditLogs.old_data}, ${path}) is not json_extract(${auditLogs.new_data}, ${path})`);
  }
  const [rows, names] = await Promise.all([
    ctx.db
      .select({
        log: auditLogs,
        current_name: leads.client_name,
      })
      .from(auditLogs)
      .leftJoin(leads, sql`${leads.id} = cast(${auditLogs.record_id} as integer)`)
      .where(and(...where))
      .orderBy(desc(auditLogs.created_at), desc(auditLogs.id))
      .limit(AUDIT_PAGE_SIZE + 1)
      .offset((page - 1) * AUDIT_PAGE_SIZE),
    profileNames(ctx),
  ]);
  const entries = rows.slice(0, AUDIT_PAGE_SIZE).map(({ log, current_name }) => {
    const before = log.old_data as Row;
    const after = log.new_data as Row;
    return {
      id: log.id,
      at: log.created_at,
      action: log.action,
      actor_id: log.actor_id,
      actor_name: log.actor_id ? (names.get(log.actor_id) ?? "A former user") : "System",
      lead_id: Number(log.record_id),
      lead_name: current_name ?? String(after?.client_name ?? before?.client_name ?? `Lead #${log.record_id}`),
      lead_exists: current_name !== null,
      changes: diffLead(log.action === "INSERT" ? null : before, log.action === "DELETE" ? null : after, names),
    };
  });
  return { entries, hasMore: rows.length > AUDIT_PAGE_SIZE };
}
