import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { startOfBusinessDay } from "@/lib/dates";
import { ACTIVITY_KINDS, LEAD_STATUSES, type ActivityKind } from "@/lib/domain";

import { leads, profiles } from "../db/schema";
import { assertAdmin, type Actor } from "./actor";
import type { DataContext } from "./context";
import { InvalidInputError } from "./errors";

// What the team did, for admins: the activity log, the live leads tracker and
// the monthly report. Nothing new is recorded for it; every action already
// leaves a row behind:
//   * audit_logs on leads: created, status changed, reassigned, edited,
//     visiting card attached, deleted (old and new rows as JSON);
//   * audit_logs on events: task or reminder ticked off (since this change;
//     older completions fall back to the task's owner and completed_at);
//   * lead_notes, events (tasks people add) and lead_contact_logs.
// Admins only: agents never see each other's work.

export type ActivityItem = {
  at: string;
  kind: ActivityKind;
  agent_id: string | null;
  /** "System" when no person did it (imports, server jobs). */
  agent_name: string;
  lead_id: number | null;
  lead_name: string;
  /** False once the lead is deleted (the name comes from the log then). */
  lead_exists: boolean;
  detail: string;
};

export type ActivityFilter = {
  /** ISO timestamps, from inclusive, to exclusive. */
  from?: string;
  to?: string;
  agentId?: string;
  kind?: ActivityKind;
  leadId?: number;
  /** Newest first, at most this many (default 300, at most 5,000). */
  limit?: number;
};

type Row = {
  at: string;
  kind: ActivityKind;
  agent_id: string | null;
  agent_name: string | null;
  lead_id: number | null;
  lead_name: string | null;
  lead_exists: number;
  a: string | null;
  b: string | null;
  text: string | null;
};

const MAX_LIMIT = 5_000;

const jsonOld = (path: string) => sql.raw(`json_extract(a.old_data, '$.${path}')`);
const jsonNew = (path: string) => sql.raw(`json_extract(a.new_data, '$.${path}')`);

function between(column: SQL, from?: string, to?: string): SQL {
  const parts = [sql`1 = 1`];
  if (from) parts.push(sql`${column} >= ${from}`);
  if (to) parts.push(sql`${column} < ${to}`);
  return sql.join(parts, sql` and `);
}

/**
 * One SELECT per source, all returning (at, kind, agent_id, agent_name, lead_id,
 * lead_name, a, b, text). The time range sits in every branch so each one uses
 * its created_at index. D1 allows at most 5 SELECTs in one UNION, so the
 * sources come in two groups, queried side by side and merged.
 */
function activitySources(from?: string, to?: string): [SQL, SQL] {
  const leadKind = sql.raw(`case
      when a.action = 'INSERT' then 'lead_created'
      when a.action = 'DELETE' then 'lead_deleted'
      when json_extract(a.old_data, '$.status') is not json_extract(a.new_data, '$.status') then 'status_changed'
      when json_extract(a.old_data, '$.assigned_agent_id') is not json_extract(a.new_data, '$.assigned_agent_id') then 'lead_assigned'
      when json_extract(a.new_data, '$.visiting_card_path') is not null
        and json_extract(a.old_data, '$.visiting_card_path') is not json_extract(a.new_data, '$.visiting_card_path') then 'card_uploaded'
      else 'lead_edited' end`);
  const audited = sql`
    select a.created_at as at, ${leadKind} as kind, a.actor_id as agent_id, null as agent_name,
      cast(a.record_id as integer) as lead_id,
      coalesce(${jsonNew("client_name")}, ${jsonOld("client_name")}) as lead_name,
      case when a.action = 'UPDATE' and ${jsonOld("status")} is not ${jsonNew("status")} then ${jsonOld("status")}
           else ${jsonOld("assigned_agent_id")} end as a,
      case when a.action = 'UPDATE' and ${jsonOld("status")} is not ${jsonNew("status")} then ${jsonNew("status")}
           else ${jsonNew("assigned_agent_id")} end as b,
      null as text
    from audit_logs a
    where a.table_name = 'leads' and ${between(sql`a.created_at`, from, to)}
    union all
    -- A lead saved with a visiting card counts as a card upload too.
    select a.created_at, 'card_uploaded', a.actor_id, null, cast(a.record_id as integer), ${jsonNew("client_name")}, null, null, null
    from audit_logs a
    where a.table_name = 'leads' and a.action = 'INSERT' and ${jsonNew("visiting_card_path")} is not null
      and ${between(sql`a.created_at`, from, to)}
    union all
    select a.created_at, 'task_completed', a.actor_id, null, ${jsonNew("lead_id")}, null, ${jsonNew("milestone")}, null, ${jsonNew("title")}
    from audit_logs a
    where a.table_name = 'events' and ${jsonNew("is_completed")} = 1 and ${between(sql`a.created_at`, from, to)}`;
  const others = sql`
    select n.created_at as at, 'note_added' as kind, n.agent_id as agent_id, n.agent_name as agent_name, n.lead_id as lead_id,
      null as lead_name, null as a, null as b, substr(n.content, 1, 500) as text
    from lead_notes n
    where ${between(sql`n.created_at`, from, to)}
    union all
    select e.created_at, 'task_created', e.created_by, null, e.lead_id, null, e.event_timestamp, null, e.title
    from events e
    where e.is_system_generated = 0 and e.created_by is not null and ${between(sql`e.created_at`, from, to)}
    union all
    -- Ticked off before completions were logged: credit the task's owner.
    select e.completed_at, 'task_completed', e.assigned_agent_id, null, e.lead_id, null, e.milestone, null, e.title
    from events e
    where e.is_completed = 1 and e.completed_at is not null and ${between(sql`e.completed_at`, from, to)}
      -- Only completion rows count here; an edit of the task is logged too but is not a completion.
      and not exists (select 1 from audit_logs x where x.table_name = 'events' and x.record_id = cast(e.id as text)
        and json_extract(x.new_data, '$.is_completed') is not null)
    union all
    select c.created_at, 'contact', c.agent_id, c.agent_name, c.lead_id, null, c.channel, c.with_draft, null
    from lead_contact_logs c
    where ${between(sql`c.created_at`, from, to)}`;
  return [audited, others];
}

const CHANNELS: Record<string, string> = { call: "Call", whatsapp: "WhatsApp", email: "Email" };

function describe(row: Row, names: Map<string, string>): string {
  const who = (id: string | null) => (id ? (names.get(id) ?? "a former user") : "Unassigned");
  switch (row.kind) {
    case "status_changed":
      return row.a ? `${row.a} → ${row.b ?? ""}` : `Status ${row.b ?? ""}`;
    case "lead_assigned":
      return `${who(row.a)} → ${who(row.b)}`;
    case "note_added":
      return row.text ?? "";
    case "task_created":
      return row.text ?? "";
    case "task_completed":
      return row.a ? `Reminder ${row.a}: ${row.text ?? ""}` : (row.text ?? "");
    case "contact":
      return `${CHANNELS[row.a ?? ""] ?? row.a ?? ""}${String(row.b) === "1" ? " with AI follow-up draft" : ""}`;
    default:
      return "";
  }
}

async function profileNames(ctx: DataContext): Promise<Map<string, string>> {
  const rows = await ctx.db.select({ id: profiles.id, name: profiles.full_name }).from(profiles);
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** The team's actions, newest first. Admins only. */
export async function listActivity(ctx: DataContext, actor: Actor, filter: ActivityFilter = {}): Promise<ActivityItem[]> {
  assertAdmin(actor);
  if (filter.kind !== undefined && !ACTIVITY_KINDS.includes(filter.kind)) throw new InvalidInputError("Unknown activity type.");
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(filter.limit ?? 300)));
  const where = [sql`1 = 1`];
  if (filter.agentId) where.push(sql`s.agent_id = ${filter.agentId}`);
  if (filter.kind) where.push(sql`s.kind = ${filter.kind}`);
  if (filter.leadId !== undefined) where.push(sql`s.lead_id = ${filter.leadId}`);

  const query = (source: SQL) =>
    ctx.db.all<Row>(sql`
      select s.at, s.kind, s.agent_id, coalesce(p.full_name, s.agent_name) as agent_name, s.lead_id,
        coalesce(l.client_name, s.lead_name) as lead_name, l.id is not null as lead_exists, s.a, s.b, s.text
      from (${source}) s
      left join ${profiles} p on p.id = s.agent_id
      left join ${leads} l on l.id = s.lead_id
      where ${sql.join(where, sql` and `)}
      order by s.at desc
      limit ${limit}`);
  const [audited, others] = activitySources(filter.from, filter.to);
  const [first, second, names] = await Promise.all([query(audited), query(others), profileNames(ctx)]);
  const rows = [...first, ...second].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).slice(0, limit);
  return rows.map((row) => ({
    at: row.at,
    kind: row.kind,
    agent_id: row.agent_id,
    agent_name: row.agent_name ?? (row.agent_id ? "A former user" : "System"),
    lead_id: row.lead_id,
    lead_name: row.lead_name ?? "",
    lead_exists: Boolean(row.lead_exists),
    detail: describe(row, names),
  }));
}

// --- Live leads tracker ---------------------------------------------------

export type TrackedLead = {
  id: number;
  client_name: string;
  type: string;
  policy_product: string;
  status: string;
  renewal_date: string | null;
  assigned_agent_id: string | null;
  agent_name: string | null;
  updated_at: string;
  /** Latest of: lead saved, note added, client contacted. */
  last_activity_at: string;
  last_changed_by: string | null;
  notes: number;
  open_tasks: number;
};

export type TrackerFilter = { agentId?: string | "unassigned"; status?: string; q?: string; limit?: number };

/** Leads by most recent activity, with owner and what last happened. Admins only. */
export async function listLeadTracker(ctx: DataContext, actor: Actor, filter: TrackerFilter = {}): Promise<TrackedLead[]> {
  assertAdmin(actor);
  const where = [sql`1 = 1`];
  if (filter.agentId === "unassigned") where.push(sql`l.assigned_agent_id is null`);
  else if (filter.agentId) where.push(sql`l.assigned_agent_id = ${filter.agentId}`);
  if (filter.status) {
    if (!(LEAD_STATUSES as readonly string[]).includes(filter.status)) throw new InvalidInputError("Unknown status.");
    where.push(sql`l.status = ${filter.status}`);
  }
  const q = filter.q?.trim().toLowerCase();
  if (q) where.push(sql`instr(lower(l.client_name), ${q.slice(0, 100)}) > 0`);
  const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 150)));

  return ctx.db.all<TrackedLead>(sql`
    select t.*, max(t.updated_at, coalesce(t.last_note_at, ''), coalesce(t.last_contact_at, '')) as last_activity_at
    from (
      select l.id, l.client_name, l.lead_type as type, l.product as policy_product, l.status, l.renewal_date, l.assigned_agent_id,
        p.full_name as agent_name, l.updated_at,
        (select max(n.created_at) from lead_notes n where n.lead_id = l.id) as last_note_at,
        (select max(c.created_at) from lead_contact_logs c where c.lead_id = l.id) as last_contact_at,
        (select coalesce(ap.full_name, 'System') from audit_logs a left join ${profiles} ap on ap.id = a.actor_id
          where a.table_name = 'leads' and a.record_id = cast(l.id as text) order by a.created_at desc limit 1) as last_changed_by,
        (select count(*) from lead_notes n where n.lead_id = l.id) as notes,
        (select count(*) from events e where e.lead_id = l.id and e.is_system_generated = 0 and e.is_completed = 0) as open_tasks
      from ${leads} l
      left join ${profiles} p on p.id = l.assigned_agent_id
      where ${sql.join(where, sql` and `)}
    ) t
    order by last_activity_at desc, t.id desc
    limit ${limit}`);
}

export type AgentToday = {
  agent_id: string | null;
  agent_name: string;
  actions: number;
  status_changes: number;
  notes: number;
  contacts: number;
  tasks_completed: number;
  leads_created: number;
  last_at: string;
};

/** Per person, what they did since `since` (an ISO timestamp), busiest first. */
export function summariseByAgent(items: ActivityItem[]): AgentToday[] {
  const byAgent = new Map<string, AgentToday>();
  for (const item of items) {
    const key = item.agent_id ?? "";
    const row =
      byAgent.get(key) ??
      ({ agent_id: item.agent_id, agent_name: item.agent_name, actions: 0, status_changes: 0, notes: 0, contacts: 0, tasks_completed: 0, leads_created: 0, last_at: item.at } satisfies AgentToday);
    row.actions++;
    if (item.kind === "status_changed") row.status_changes++;
    if (item.kind === "note_added") row.notes++;
    if (item.kind === "contact") row.contacts++;
    if (item.kind === "task_completed") row.tasks_completed++;
    if (item.kind === "lead_created") row.leads_created++;
    if (item.at > row.last_at) row.last_at = item.at;
    byAgent.set(key, row);
  }
  return [...byAgent.values()].sort((a, b) => b.actions - a.actions || a.agent_name.localeCompare(b.agent_name));
}

// --- Monthly report ---------------------------------------------------------

export type ReportLead = typeof leads.$inferSelect & { agent_name: string; created_by_name: string };
export type ReportNote = { lead_id: number; agent_name: string; content: string; created_at: string };
export type ReportTask = { lead_id: number; title: string; event_timestamp: string; is_completed: boolean; completed_at: string | null; owner_name: string };

export type MonthlyReport = {
  month: string;
  from: string;
  to: string;
  generated_at: string;
  team: { id: string; full_name: string; role: string; is_active: boolean }[];
  leads: ReportLead[];
  notes: ReportNote[];
  tasks: ReportTask[];
  /** This month's actions, oldest first. */
  activity: ActivityItem[];
};

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The IST month as [from, to) ISO timestamps. */
export function monthRange(month: string): { from: string; to: string } {
  const match = MONTH.exec(month);
  if (!match) throw new InvalidInputError("Pick a month as YYYY-MM.");
  const year = Number(match[1]);
  const next = Number(match[2]) === 12 ? `${year + 1}-01` : `${year}-${String(Number(match[2]) + 1).padStart(2, "0")}`;
  return { from: startOfBusinessDay(`${month}-01`), to: startOfBusinessDay(`${next}-01`) };
}

/**
 * Everything the monthly report sheet needs: every lead as it stands now, all
 * their notes and tasks, and the month's activity. Admins only.
 */
export async function monthlyReport(ctx: DataContext, actor: Actor, month: string, now: Date = new Date()): Promise<MonthlyReport> {
  assertAdmin(actor);
  const { from, to } = monthRange(month);
  const [team, leadRows, notes, tasks, activity] = await Promise.all([
    ctx.db
      .select({ id: profiles.id, full_name: profiles.full_name, role: profiles.role, is_active: profiles.is_active })
      .from(profiles)
      .orderBy(profiles.full_name),
    ctx.db.select().from(leads).orderBy(leads.client_name, leads.id),
    ctx.db.all<ReportNote>(sql`select lead_id, agent_name, content, created_at from lead_notes order by lead_id, created_at, id`),
    ctx.db.all<Omit<ReportTask, "is_completed"> & { is_completed: number }>(sql`
      select e.lead_id, e.title, e.event_timestamp, e.is_completed, e.completed_at, coalesce(p.full_name, '') as owner_name
      from events e left join ${profiles} p on p.id = e.assigned_agent_id
      where e.lead_id is not null and e.is_system_generated = 0
      order by e.lead_id, e.event_timestamp, e.id`),
    listActivity(ctx, actor, { from, to, limit: MAX_LIMIT }),
  ]);
  const names = new Map(team.map((t) => [t.id, t.full_name]));
  return {
    month,
    from,
    to,
    generated_at: now.toISOString(),
    team,
    leads: leadRows.map((lead) => ({
      ...lead,
      agent_name: lead.assigned_agent_id ? (names.get(lead.assigned_agent_id) ?? "") : "Unassigned",
      created_by_name: lead.created_by ? (names.get(lead.created_by) ?? "") : "",
    })),
    notes,
    tasks: tasks.map((t) => ({ ...t, is_completed: Boolean(t.is_completed) })),
    activity: activity.reverse(),
  };
}
