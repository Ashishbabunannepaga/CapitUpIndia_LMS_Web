import "server-only";

import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import {
  auditLogs,
  deletedLeads,
  events,
  leadContactLogs,
  leadNoteReads,
  leadNotes,
  leadTags,
  leadTransactions,
  leads,
  playbookTasks,
  profiles,
  visitingCardPreviews,
  workTasks,
} from "../db/schema";
import { assertAdmin, type Actor } from "./actor";
import { auditInsert } from "./audit";
import type { DataContext } from "./context";
import { duplicateState } from "./duplicates";
import { InvalidInputError } from "./errors";

// Data safety (audit R10):
//   * Deleting a lead moves it, and everything that hung off it, to a bin
//     (deleted_leads) for BIN_DAYS. An admin can restore it with its original
//     id, notes, calendar entries, tags, transactions and contact log.
//   * Every Excel export is recorded (who, which report, how many rows, which
//     filters), so a download of client data always leaves a trace.

/** Days a deleted lead can be restored. */
export const BIN_DAYS = 90;

const EXPORTS_TABLE = "exports";

type Snapshot = {
  lead: typeof leads.$inferSelect;
  events: (typeof events.$inferSelect)[];
  notes: (typeof leadNotes.$inferSelect)[];
  note_reads: (typeof leadNoteReads.$inferSelect)[];
  tags: (typeof leadTags.$inferSelect)[];
  transactions: (typeof leadTransactions.$inferSelect)[];
  contacts: (typeof leadContactLogs.$inferSelect)[];
  playbook_tasks: (typeof playbookTasks.$inferSelect)[];
  /** Task Grid tasks linked to the lead (the delete unlinks them; restoring links them again). */
  work_task_ids: number[];
};

/**
 * Deletes a lead into the bin. Admins only. The snapshot is read first and
 * written in the same batch as the delete, so a lead is never gone without
 * its copy.
 */
export async function deleteLeadToBin(ctx: DataContext, actor: Actor, id: number): Promise<void> {
  assertAdmin(actor);
  const lead = await ctx.db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!lead) throw new InvalidInputError("That lead no longer exists or isn't yours.");
  const [leadEvents, notes, tags, transactions, contacts, playbook, tasks] = await ctx.db.batch([
    ctx.db.select().from(events).where(eq(events.lead_id, id)),
    ctx.db.select().from(leadNotes).where(eq(leadNotes.lead_id, id)),
    ctx.db.select().from(leadTags).where(eq(leadTags.lead_id, id)),
    ctx.db.select().from(leadTransactions).where(eq(leadTransactions.lead_id, id)),
    ctx.db.select().from(leadContactLogs).where(eq(leadContactLogs.lead_id, id)),
    ctx.db.select().from(playbookTasks).where(eq(playbookTasks.lead_id, id)),
    ctx.db.select({ id: workTasks.id }).from(workTasks).where(eq(workTasks.lead_id, id)),
  ]);
  const noteIds = notes.map((n) => n.id);
  const noteReads: Snapshot["note_reads"] = [];
  for (let i = 0; i < noteIds.length; i += 90) {
    noteReads.push(...(await ctx.db.select().from(leadNoteReads).where(inArray(leadNoteReads.note_id, noteIds.slice(i, i + 90)))));
  }
  const snapshot: Snapshot = {
    lead,
    events: leadEvents,
    notes,
    note_reads: noteReads,
    tags,
    transactions,
    contacts,
    playbook_tasks: playbook,
    work_task_ids: tasks.map((t) => t.id),
  };
  const stamp = new Date().toISOString();
  await ctx.db.batch([
    ctx.db
      .insert(deletedLeads)
      .values({ lead_id: id, client_name: lead.client_name, assigned_agent_id: lead.assigned_agent_id, deleted_by: actor.id, deleted_at: stamp, snapshot })
      .onConflictDoUpdate({ target: deletedLeads.lead_id, set: { deleted_by: actor.id, deleted_at: stamp, snapshot } }),
    ctx.db.delete(leads).where(eq(leads.id, id)),
    // The compressed card copy goes with the lead (the R2 photo is kept, so a restore still has the full photo).
    ctx.db.delete(visitingCardPreviews).where(eq(visitingCardPreviews.path, lead.visiting_card_path ?? "")),
    auditInsert(ctx, actor, "leads", id, "DELETE", lead, null),
  ]);
}

export type DeletedLead = {
  lead_id: number;
  client_name: string;
  owner_name: string | null;
  deleted_by_name: string | null;
  deleted_at: string;
  notes: number;
  events: number;
};

/** The bin, newest first. Admins only. */
export async function listDeletedLeads(ctx: DataContext, actor: Actor, limit = 100): Promise<DeletedLead[]> {
  assertAdmin(actor);
  const [rows, team] = await Promise.all([
    ctx.db.select().from(deletedLeads).orderBy(desc(deletedLeads.deleted_at)).limit(Math.min(Math.max(limit, 1), 500)),
    ctx.db.select({ id: profiles.id, full_name: profiles.full_name }).from(profiles),
  ]);
  const names = new Map(team.map((p) => [p.id, p.full_name]));
  return rows.map((row) => {
    const snapshot = row.snapshot as Snapshot;
    return {
      lead_id: row.lead_id,
      client_name: row.client_name,
      owner_name: row.assigned_agent_id ? (names.get(row.assigned_agent_id) ?? "A former user") : null,
      deleted_by_name: row.deleted_by ? (names.get(row.deleted_by) ?? null) : null,
      deleted_at: row.deleted_at,
      notes: snapshot.notes?.length ?? 0,
      events: snapshot.events?.length ?? 0,
    };
  });
}

/** Inserts rows in chunks that stay under D1's 100 bound parameters per statement. */
function chunkedInserts<T extends Record<string, unknown>>(ctx: DataContext, table: SQLiteTable, rows: T[]): BatchItem<"sqlite">[] {
  if (rows.length === 0) return [];
  const per = Math.max(1, Math.floor(99 / Math.max(Object.keys(rows[0]).length, 1)));
  const out: BatchItem<"sqlite">[] = [];
  for (let i = 0; i < rows.length; i += per) {
    out.push(ctx.db.insert(table).values(rows.slice(i, i + per) as never).onConflictDoNothing());
  }
  return out;
}

/**
 * Puts a deleted lead back with its original id and everything that hung
 * off it. Admins only. An owner who has since been disabled is dropped (the
 * lead comes back unassigned), and the duplicate flag is worked out again.
 * Returns the lead id.
 */
export async function restoreDeletedLead(ctx: DataContext, actor: Actor, leadId: number): Promise<number> {
  assertAdmin(actor);
  const row = await ctx.db.query.deletedLeads.findFirst({ where: eq(deletedLeads.lead_id, leadId) });
  if (!row) throw new InvalidInputError("That lead is no longer in the bin.");
  if (await ctx.db.query.leads.findFirst({ columns: { id: true }, where: eq(leads.id, leadId) })) {
    throw new InvalidInputError("A lead with that number already exists.");
  }
  const snapshot = row.snapshot as Snapshot;
  const team = await ctx.db.select({ id: profiles.id, is_active: profiles.is_active }).from(profiles);
  const active = new Set(team.filter((p) => p.is_active).map((p) => p.id));
  const owner = snapshot.lead.assigned_agent_id && active.has(snapshot.lead.assigned_agent_id) ? snapshot.lead.assigned_agent_id : null;
  const dup = await duplicateState(ctx, snapshot.lead.client_name, leadId);
  const lead = {
    ...snapshot.lead,
    assigned_agent_id: owner,
    assigned_at: owner ? snapshot.lead.assigned_at : null,
    ...dup,
    updated_at: new Date().toISOString(),
  };
  const known = new Set(team.map((p) => p.id));
  // Calendar entries of a disabled owner follow the lead to its new (no) owner.
  const leadEvents = (snapshot.events ?? []).map((e) => (e.is_system_generated && e.assigned_agent_id !== owner ? { ...e, assigned_agent_id: owner } : e));
  const noteReads = (snapshot.note_reads ?? []).filter((r) => known.has(r.user_id));

  const statements: BatchItem<"sqlite">[] = [
    ctx.db.insert(leads).values(lead),
    ...chunkedInserts(ctx, events, leadEvents),
    ...chunkedInserts(ctx, leadNotes, snapshot.notes ?? []),
    ...chunkedInserts(ctx, leadNoteReads, noteReads),
    ...chunkedInserts(ctx, leadTags, snapshot.tags ?? []),
    ...chunkedInserts(ctx, leadTransactions, snapshot.transactions ?? []),
    ...chunkedInserts(ctx, leadContactLogs, snapshot.contacts ?? []),
    ...chunkedInserts(ctx, playbookTasks, snapshot.playbook_tasks ?? []),
  ];
  const taskIds = snapshot.work_task_ids ?? [];
  for (let i = 0; i < taskIds.length; i += 90) {
    statements.push(
      ctx.db
        .update(workTasks)
        .set({ lead_id: leadId })
        .where(and(inArray(workTasks.id, taskIds.slice(i, i + 90)))),
    );
  }
  statements.push(
    ctx.db.delete(deletedLeads).where(eq(deletedLeads.lead_id, leadId)),
    auditInsert(ctx, actor, "leads", leadId, "INSERT", null, { ...lead, restored_from_bin: true }),
  );
  await ctx.db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return leadId;
}

/** Empties the bin of leads deleted more than BIN_DAYS ago (the cron, daily). Returns how many. */
export async function purgeDeletedLeads(ctx: DataContext, at: Date = new Date()): Promise<number> {
  const cutoff = new Date(at.getTime() - BIN_DAYS * 86_400_000).toISOString();
  const gone = await ctx.db.delete(deletedLeads).where(lt(deletedLeads.deleted_at, cutoff)).returning({ id: deletedLeads.lead_id });
  return gone.length;
}

// --- Export log ---------------------------------------------------------------

export type ExportReport = "leads_selected" | "leads_filtered" | "renewal_report" | "monthly_report";

export const EXPORT_LABELS: Record<ExportReport, string> = {
  leads_selected: "Leads (selected)",
  leads_filtered: "Leads (filtered)",
  renewal_report: "Renewal report",
  monthly_report: "Monthly activity report",
};

/** Records one Excel export. Called by every download route after the data function let the caller through. */
export async function recordExport(
  ctx: DataContext,
  actor: Actor,
  entry: { report: ExportReport; rows: number; filters?: Record<string, string> },
): Promise<void> {
  const filters = Object.fromEntries(Object.entries(entry.filters ?? {}).filter(([, v]) => v !== "").slice(0, 20));
  await auditInsert(ctx, actor, EXPORTS_TABLE, entry.report, "INSERT", null, { report: entry.report, rows: entry.rows, filters });
}

export type ExportLogEntry = { id: number; at: string; actor_name: string; report: string; rows: number; filters: Record<string, string> };

/** Recent exports, newest first. Admins only. */
export async function listExports(ctx: DataContext, actor: Actor, limit = 100): Promise<ExportLogEntry[]> {
  assertAdmin(actor);
  const [rows, team] = await Promise.all([
    ctx.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.table_name, EXPORTS_TABLE))
      .orderBy(desc(auditLogs.created_at), desc(auditLogs.id))
      .limit(Math.min(Math.max(limit, 1), 500)),
    ctx.db.select({ id: profiles.id, full_name: profiles.full_name }).from(profiles),
  ]);
  const names = new Map(team.map((p) => [p.id, p.full_name]));
  return rows.map((row) => {
    const data = (row.new_data ?? {}) as { report?: ExportReport; rows?: number; filters?: Record<string, string> };
    return {
      id: row.id,
      at: row.created_at,
      actor_name: row.actor_id ? (names.get(row.actor_id) ?? "A former user") : "System",
      report: (data.report && EXPORT_LABELS[data.report]) || row.record_id,
      rows: Number(data.rows ?? 0),
      filters: data.filters ?? {},
    };
  });
}
