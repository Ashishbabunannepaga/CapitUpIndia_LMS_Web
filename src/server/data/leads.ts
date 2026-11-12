import "server-only";

import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { BatchItem } from "drizzle-orm/batch";

import { normalizeCompanyName } from "@/lib/company-name";
import { addDays, todayInBusinessTz } from "@/lib/dates";
import { CLOSED_STATUSES, DEFAULT_POC_DESIGNATION, LEAD_STATUSES, isContactChannel, isLeadStatus } from "@/lib/domain";
import { type LeadFilters, searchTerms } from "@/lib/lead-filters";
import { isOwnCardPath } from "@/lib/visiting-cards";

import { appSettings, events, leadContactLogs, leadNoteReads, leadNotes, leads, profiles, renewalMilestoneOffsets, visitingCardPreviews } from "../db/schema";
import { isAdmin, assertAdmin, type Actor } from "./actor";
import { auditInsert, changed } from "./audit";
import type { DataContext } from "./context";
import { duplicateState } from "./duplicates";
import { AccessDeniedError, InvalidInputError } from "./errors";
import { milestoneEvents } from "./milestones";

// Leads, their notes and contacts. These carry the rules the Supabase RLS
// policies and triggers enforced:
//   * agents see and change only leads assigned to them; admins see all;
//   * agents create leads only for themselves and cannot reassign them;
//   * duplicate flags, ownership and timestamps are set here, never taken
//     from the caller;
//   * renewal milestones follow the lead's renewal date, owner, name and product;
//   * only admins delete leads, resolve duplicates or reassign.
// A lead the caller cannot see behaves exactly like one that does not exist.

export type Lead = typeof leads.$inferSelect;
export type LeadWithAgent = Lead & { agent_name: string | null };
export type LeadNote = typeof leadNotes.$inferSelect;
export type LeadEvent = typeof events.$inferSelect;
export type LeadContactLog = typeof leadContactLogs.$inferSelect;

/** Leads per page in the table and card views. */
export const LEAD_PAGE_SIZE = 100;
/** Cards per status column on the board; column headers still show the full count. */
export const KANBAN_COLUMN_LIMIT = 50;
const NOT_FOUND = "That lead no longer exists or isn't yours.";

/** Lead fields a form can set. Everything else is decided here. */
export type LeadFields = {
  client_name: string;
  type: Lead["type"];
  business_type: Lead["business_type"];
  policy_product: Lead["policy_product"];
  sub_product_name: string;
  address: string;
  renewal_date: string | null;
  poc_name: string;
  poc_designation: string;
  poc_contact_number: string;
  poc_email_id: string;
  poc2_name: string;
  poc2_designation: string;
  poc2_contact_number: string;
  poc2_email_id: string;
  notes: string;
  relationship_manager: string;
  status: Lead["status"];
};

export type NewLead = Partial<LeadFields> & {
  client_name: string;
  assigned_agent_id?: string | null;
  visiting_card_path?: string | null;
  /** Set only by the office hand-over (admins): the capitupindia.com call request it came from. */
  office_lead_id?: string | null;
  /** Set only by the app hand-over (admins): the CapitUp app user who opted in to be contacted. */
  app_user_id?: string | null;
};

const FIELD_NAMES: (keyof LeadFields)[] = [
  "client_name",
  "type",
  "business_type",
  "policy_product",
  "sub_product_name",
  "address",
  "renewal_date",
  "poc_name",
  "poc_designation",
  "poc_contact_number",
  "poc_email_id",
  "poc2_name",
  "poc2_designation",
  "poc2_contact_number",
  "poc2_email_id",
  "notes",
  "relationship_manager",
  "status",
];

function now(): string {
  return new Date().toISOString();
}

/** The caller's lead scope (null for admins: everything). */
function scope(actor: Actor): SQL | undefined {
  return isAdmin(actor) ? undefined : eq(leads.assigned_agent_id, actor.id);
}

function pickFields(input: Partial<LeadFields>): Partial<LeadFields> {
  const out: Partial<LeadFields> = {};
  for (const key of FIELD_NAMES) {
    if (input[key] !== undefined) (out as Record<string, unknown>)[key] = input[key];
  }
  return out;
}

/** The same clean-up the leads_before_write trigger did. */
function tidy<T extends Partial<LeadFields>>(fields: T): T {
  const out = { ...fields };
  if (out.client_name !== undefined) out.client_name = out.client_name.trim();
  if (out.poc_email_id !== undefined) out.poc_email_id = out.poc_email_id.trim().toLowerCase();
  if (out.poc2_email_id !== undefined) out.poc2_email_id = out.poc2_email_id.trim().toLowerCase();
  if (out.poc_designation !== undefined) out.poc_designation = out.poc_designation.trim() || DEFAULT_POC_DESIGNATION;
  if (out.relationship_manager !== undefined) out.relationship_manager = out.relationship_manager.trim();
  return out;
}

async function renewalSettings(ctx: DataContext) {
  const [offsets, dueTime] = await Promise.all([
    ctx.db
      .select({ milestone: renewalMilestoneOffsets.milestone, offset_seconds: renewalMilestoneOffsets.offset_seconds })
      .from(renewalMilestoneOffsets)
      .orderBy(asc(renewalMilestoneOffsets.sort_order)),
    ctx.db.query.appSettings.findFirst({ where: eq(appSettings.key, "renewal_due_time") }),
  ]);
  const time = typeof dueTime?.value === "string" && /^\d{2}:\d{2}$/.test(dueTime.value) ? dueTime.value : "10:00";
  return { offsets, dueTime: time };
}

async function assertAssignable(ctx: DataContext, agentId: string | null) {
  if (!agentId) return;
  const agent = await ctx.db.query.profiles.findFirst({ where: eq(profiles.id, agentId) });
  if (!agent?.is_active) throw new InvalidInputError("Pick an active team member.");
}

function assertCardPath(actor: Actor, path: string | null | undefined) {
  if (!path) return;
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(path) || (!isAdmin(actor) && !isOwnCardPath(path, actor.id))) {
    throw new AccessDeniedError("You can only attach visiting cards you uploaded.");
  }
}

async function findVisible(ctx: DataContext, actor: Actor, id: number): Promise<Lead> {
  const lead = await ctx.db.query.leads.findFirst({ where: and(eq(leads.id, id), scope(actor)) });
  if (!lead) throw new InvalidInputError(NOT_FOUND);
  return lead;
}

function withNames<T extends { assigned_agent_id: string | null }>(rows: T[], team: Map<string, string>) {
  return rows.map((row) => ({
    ...row,
    agent_name: row.assigned_agent_id ? (team.get(row.assigned_agent_id) ?? null) : null,
  }));
}

async function teamNames(ctx: DataContext): Promise<Map<string, string>> {
  const rows = await ctx.db.select({ id: profiles.id, full_name: profiles.full_name }).from(profiles);
  return new Map(rows.map((r) => [r.id, r.full_name]));
}

// --- Reads -----------------------------------------------------------------

export async function getLead(ctx: DataContext, actor: Actor, id: number): Promise<LeadWithAgent | null> {
  const [lead, team] = await Promise.all([
    ctx.db.query.leads.findFirst({ where: and(eq(leads.id, id), scope(actor)) }),
    teamNames(ctx),
  ]);
  if (!lead) return null;
  const [named] = withNames([lead], team);
  return named;
}

export type LeadPage = {
  lead: LeadWithAgent;
  notes: LeadNote[];
  /** Like getLeadEvents. */
  events: LeadEvent[];
  contacts: LeadContactLog[];
  team: Pick<Actor, "id" | "full_name" | "role" | "is_active">[];
  /** The caller's unread notes on this lead. */
  unreadNoteIds: number[];
};

/**
 * Everything the lead screen shows (bar similar companies) in one D1 round
 * trip, or null when the caller cannot see the lead. The lead's own rows are
 * read in the same batch as the access check and are only returned when the
 * lead itself came back for this caller, so the check is the same as
 * getLeadNotes / getLeadEvents / getLeadContactLog.
 */
export async function getLeadPage(ctx: DataContext, actor: Actor, id: number): Promise<LeadPage | null> {
  const [found, team, notes, leadEvents, contacts, unread] = await ctx.db.batch([
    ctx.db.select().from(leads).where(and(eq(leads.id, id), scope(actor))).limit(1),
    ctx.db
      .select({ id: profiles.id, full_name: profiles.full_name, role: profiles.role, is_active: profiles.is_active })
      .from(profiles)
      .orderBy(asc(profiles.full_name)),
    ctx.db.select().from(leadNotes).where(eq(leadNotes.lead_id, id)).orderBy(desc(leadNotes.created_at), desc(leadNotes.id)),
    ctx.db
      .select()
      .from(events)
      .where(and(eq(events.lead_id, id), isAdmin(actor) ? undefined : eq(events.assigned_agent_id, actor.id)))
      .orderBy(asc(events.event_timestamp)),
    ctx.db
      .select()
      .from(leadContactLogs)
      .where(eq(leadContactLogs.lead_id, id))
      .orderBy(desc(leadContactLogs.created_at), desc(leadContactLogs.id))
      .limit(20),
    ctx.db
      .select({ id: leadNotes.id })
      .from(leadNotes)
      .innerJoin(leads, eq(leads.id, leadNotes.lead_id))
      .where(unreadWhere(actor, id)),
  ]);
  const lead = found[0];
  if (!lead) return null;
  const [named] = withNames([lead], new Map(team.map((m) => [m.id, m.full_name])));
  return { lead: named, notes, events: leadEvents, contacts, team, unreadNoteIds: unread.map((n) => n.id) };
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function filterConditions(actor: Actor, filters: LeadFilters, today: string): SQL[] {
  const conditions: (SQL | undefined)[] = [scope(actor)];
  const terms = searchTerms(filters.q);
  if (terms.length > 0) {
    const columns = [
      leads.client_name,
      leads.poc_name,
      leads.poc2_name,
      leads.sub_product_name,
      leads.poc_contact_number,
      leads.poc2_contact_number,
      leads.poc_email_id,
      leads.poc2_email_id,
      leads.notes,
    ];
    // Phone numbers are stored as typed ("+91 98450-12345"); digit searches
    // also match them with the punctuation removed.
    const digitsOnly = (column: AnySQLiteColumn) =>
      sql`replace(replace(replace(replace(replace(replace(${column}, ' ', ''), '-', ''), '+', ''), '(', ''), ')', ''), '.', '')`;
    conditions.push(
      or(
        ...terms.flatMap((term) => {
          const pattern = `%${escapeLike(term)}%`;
          const matches = columns.map((column) => sql`${column} like ${pattern} escape '\\'`);
          if (/^\d{4,}$/.test(term)) {
            matches.push(sql`${digitsOnly(leads.poc_contact_number)} like ${pattern}`, sql`${digitsOnly(leads.poc2_contact_number)} like ${pattern}`);
          }
          return matches;
        }),
      ),
    );
  }
  if (filters.status) conditions.push(eq(leads.status, filters.status));
  if (filters.product) conditions.push(eq(leads.policy_product, filters.product));
  if (filters.type) conditions.push(eq(leads.type, filters.type));
  if (filters.agent === "unassigned") conditions.push(isNull(leads.assigned_agent_id));
  else if (filters.agent) conditions.push(eq(leads.assigned_agent_id, filters.agent));
  if (filters.duplicates) conditions.push(eq(leads.is_duplicate, true));
  switch (filters.renewal) {
    case "overdue":
      conditions.push(lt(leads.renewal_date, today), notInArray(leads.status, [...CLOSED_STATUSES]));
      break;
    case "7":
    case "30":
    case "90":
      conditions.push(gte(leads.renewal_date, today), lte(leads.renewal_date, addDays(today, Number(filters.renewal))));
      break;
    case "none":
      conditions.push(isNull(leads.renewal_date));
      break;
  }
  return conditions.filter((c): c is SQL => c !== undefined);
}

/**
 * One page of the leads matching the filters. The board (filters.view
 * "kanban") instead gets the first KANBAN_COLUMN_LIMIT leads of every status.
 * `truncated` says more leads match than came back. Pages are kept small
 * because rendering hundreds of rows was most of a request's CPU time.
 */
export async function listLeads(
  ctx: DataContext,
  actor: Actor,
  filters: LeadFilters,
): Promise<{ leads: LeadWithAgent[]; truncated: boolean }> {
  const where = and(...filterConditions(actor, filters, todayInBusinessTz()));
  const order = {
    name: [asc(leads.client_name_normalized), asc(leads.id)],
    renewal_asc: [sql`${leads.renewal_date} is null`, asc(leads.renewal_date), asc(leads.id)],
    renewal_desc: [sql`${leads.renewal_date} is null`, desc(leads.renewal_date), asc(leads.id)],
    created: [desc(leads.created_at), desc(leads.id)],
    updated: [desc(leads.updated_at), desc(leads.id)],
  }[filters.sort] ?? [desc(leads.updated_at), desc(leads.id)];

  let query;
  if (filters.view === "kanban") {
    // Rank within each status, keep one extra per column to know if it was cut.
    const ranked = ctx.db
      .select({
        id: leads.id,
        rank: sql<number>`row_number() over (partition by ${leads.status} order by ${sql.join(order, sql`, `)})`.as("rank"),
      })
      .from(leads)
      .where(where)
      .as("ranked");
    query = ctx.db
      .select()
      .from(leads)
      .where(
        and(where, inArray(leads.id, ctx.db.select({ id: ranked.id }).from(ranked).where(lte(ranked.rank, KANBAN_COLUMN_LIMIT + 1)))),
      )
      .orderBy(...order);
  } else {
    query = ctx.db
      .select()
      .from(leads)
      .where(where)
      .orderBy(...order)
      .limit(LEAD_PAGE_SIZE + 1)
      .offset((Math.max(filters.page, 1) - 1) * LEAD_PAGE_SIZE);
  }
  const [rows, team] = await Promise.all([query, teamNames(ctx)]);

  let kept: Lead[];
  let truncated: boolean;
  if (filters.view === "kanban") {
    const perStatus = new Map<string, number>();
    kept = rows.filter((row) => {
      const n = (perStatus.get(row.status) ?? 0) + 1;
      perStatus.set(row.status, n);
      return n <= KANBAN_COLUMN_LIMIT;
    });
    truncated = kept.length < rows.length;
  } else {
    kept = rows.slice(0, LEAD_PAGE_SIZE);
    truncated = rows.length > LEAD_PAGE_SIZE;
  }
  return { leads: withNames(kept, team), truncated };
}

export type LeadChoice = { id: number; client_name: string };

/**
 * Leads the caller can see whose company name contains `query`, for linking
 * a task or meeting to a lead. Agents only find their own.
 */
export async function pickLeads(ctx: DataContext, actor: Actor, query: string, limit = 8): Promise<LeadChoice[]> {
  const term = query.trim().slice(0, 100);
  if (!term) return [];
  return ctx.db
    .select({ id: leads.id, client_name: leads.client_name })
    .from(leads)
    .where(and(scope(actor), sql`${leads.client_name} like ${`%${escapeLike(term)}%`} escape '\\'`))
    .orderBy(asc(leads.client_name_normalized), asc(leads.id))
    .limit(Math.min(Math.max(limit, 1), 20));
}

/** How many leads match the filters in each status (board columns beyond the list limit). */
export async function countLeadsByStatus(ctx: DataContext, actor: Actor, filters: LeadFilters) {
  const where = and(...filterConditions(actor, { ...filters, status: null }, todayInBusinessTz()));
  const rows = await ctx.db.select({ status: leads.status, n: count() }).from(leads).where(where).groupBy(leads.status);
  const counts = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<Lead["status"], number>;
  for (const row of rows) {
    if (!filters.status || filters.status === row.status) counts[row.status] = row.n;
  }
  return counts;
}

export async function getLeadNotes(ctx: DataContext, actor: Actor, leadId: number): Promise<LeadNote[]> {
  await findVisible(ctx, actor, leadId);
  return ctx.db
    .select()
    .from(leadNotes)
    .where(eq(leadNotes.lead_id, leadId))
    .orderBy(desc(leadNotes.created_at), desc(leadNotes.id));
}

/** Calendar events on a lead the caller can see (the renewal due date and tasks), oldest first. */
export async function getLeadEvents(ctx: DataContext, actor: Actor, leadId: number): Promise<LeadEvent[]> {
  await findVisible(ctx, actor, leadId);
  return ctx.db
    .select()
    .from(events)
    .where(and(eq(events.lead_id, leadId), isAdmin(actor) ? undefined : eq(events.assigned_agent_id, actor.id)))
    .orderBy(asc(events.event_timestamp));
}

/** Every lead sharing a company name with a flagged duplicate, oldest first. Admins only. */
export async function listDuplicateGroups(ctx: DataContext, actor: Actor): Promise<Lead[]> {
  assertAdmin(actor);
  const flagged = ctx.db
    .selectDistinct({ name: leads.client_name_normalized })
    .from(leads)
    .where(eq(leads.is_duplicate, true))
    .limit(500);
  return ctx.db
    .select()
    .from(leads)
    .where(inArray(leads.client_name_normalized, flagged))
    .orderBy(asc(leads.created_at), asc(leads.id));
}

// --- Writes ----------------------------------------------------------------

/** Creates a lead. Agents own what they create; admins pick an owner or none. Returns the new id. */
export async function createLead(ctx: DataContext, actor: Actor, input: NewLead): Promise<number> {
  const fields = tidy(pickFields(input));
  if (!fields.client_name) throw new InvalidInputError("Enter the client or company name.");
  const owner = isAdmin(actor) ? (input.assigned_agent_id ?? null) : actor.id;
  if (!isAdmin(actor) && input.assigned_agent_id && input.assigned_agent_id !== actor.id) {
    throw new AccessDeniedError("Agents can only create leads for themselves.");
  }
  await assertAssignable(ctx, owner);
  assertCardPath(actor, input.visiting_card_path);
  if (input.office_lead_id && !isAdmin(actor)) throw new AccessDeniedError("Only admins can hand over office call requests.");
  if (input.app_user_id && !isAdmin(actor)) throw new AccessDeniedError("Only admins can hand over app leads.");

  const [dup, renewal] = await Promise.all([duplicateState(ctx, fields.client_name), renewalSettings(ctx)]);
  const stamp = now();
  const row = {
    ...fields,
    client_name: fields.client_name,
    client_name_normalized: normalizeCompanyName(fields.client_name),
    assigned_agent_id: owner,
    assigned_at: owner ? stamp : null,
    visiting_card_path: input.visiting_card_path ?? null,
    office_lead_id: input.office_lead_id ?? null,
    app_user_id: input.app_user_id ?? null,
    created_by: actor.id,
    created_at: stamp,
    updated_at: stamp,
    ...dup,
    duplicate_resolved_at: null,
    duplicate_resolved_by: null,
  };

  // One D1 batch (a transaction). Later statements find the new lead as the
  // highest id: nothing else can write in between.
  const newId = sql<number>`(select max(${leads.id}) from ${leads})`;
  const milestones = milestoneEvents(
    { client_name: row.client_name, policy_product: row.policy_product ?? "Not Specified", renewal_date: row.renewal_date ?? null, assigned_agent_id: owner },
    renewal.offsets,
    renewal.dueTime,
  );
  const [inserted] = await ctx.db.batch([
    ctx.db.insert(leads).values(row).returning({ id: leads.id }),
    ...milestones.map((event) => ctx.db.insert(events).values({ ...event, lead_id: newId })),
    auditInsert(ctx, actor, "leads", sql`(select cast(max(${leads.id}) as text) from ${leads})`, "INSERT", null, row),
  ]);
  return inserted[0].id;
}

/** Applies a change to a lead with everything that follows from it, in one batch. */
async function writeLead(ctx: DataContext, actor: Actor, before: Lead, patch: Partial<Lead>): Promise<void> {
  const stamp = now();
  const after: Lead = { ...before, ...patch };
  if (after.assigned_agent_id !== before.assigned_agent_id) after.assigned_at = after.assigned_agent_id ? stamp : null;
  after.client_name_normalized = normalizeCompanyName(after.client_name);
  if (after.client_name_normalized !== before.client_name_normalized) {
    Object.assign(after, await duplicateState(ctx, after.client_name, before.id), {
      duplicate_resolved_at: null,
      duplicate_resolved_by: null,
    });
  }
  if (!changed(before, after)) return;
  after.updated_at = stamp;

  const { id, ...values } = after;
  const statements: BatchItem<"sqlite">[] = [ctx.db.update(leads).set(values).where(eq(leads.id, id))];
  const system = and(eq(events.lead_id, id), eq(events.is_system_generated, true));

  if (after.renewal_date !== before.renewal_date) {
    const renewal = await renewalSettings(ctx);
    statements.push(ctx.db.delete(events).where(system));
    for (const event of milestoneEvents(after, renewal.offsets, renewal.dueTime)) {
      statements.push(ctx.db.insert(events).values({ ...event, lead_id: id }));
    }
  } else {
    if (after.assigned_agent_id !== before.assigned_agent_id) {
      statements.push(ctx.db.update(events).set({ assigned_agent_id: after.assigned_agent_id }).where(system));
    }
    if (after.client_name !== before.client_name || after.policy_product !== before.policy_product) {
      const suffix = `${after.client_name} (${after.policy_product})`;
      statements.push(
        ctx.db
          .update(events)
          .set({
            title: sql`substr(case when ${events.milestone} = 'DUE' then ${"Renewal due: " + suffix}
              else ${events.milestone} || ${" renewal reminder: " + suffix} end, 1, 300)`,
          })
          .where(system),
      );
    }
  }
  statements.push(auditInsert(ctx, actor, "leads", id, "UPDATE", before, after));
  await ctx.db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

/** Edits a lead's details. Only admins can change the owner. */
export async function updateLead(
  ctx: DataContext,
  actor: Actor,
  id: number,
  input: Partial<LeadFields> & { assigned_agent_id?: string | null },
): Promise<void> {
  const before = await findVisible(ctx, actor, id);
  const patch: Partial<Lead> = tidy(pickFields(input));
  if (patch.client_name === "") throw new InvalidInputError("Enter the client or company name.");
  if (input.assigned_agent_id !== undefined && input.assigned_agent_id !== before.assigned_agent_id) {
    assertAdmin(actor);
    await assertAssignable(ctx, input.assigned_agent_id);
    patch.assigned_agent_id = input.assigned_agent_id;
  }
  await writeLead(ctx, actor, before, patch);
}

export async function setLeadStatus(ctx: DataContext, actor: Actor, id: number, status: unknown): Promise<void> {
  if (!isLeadStatus(status)) throw new InvalidInputError("Unknown status.");
  await writeLead(ctx, actor, await findVisible(ctx, actor, id), { status });
}

/** Gives a lead to an active team member, or unassigns it. Admins only. */
export async function assignLead(ctx: DataContext, actor: Actor, id: number, agentId: string | null): Promise<void> {
  assertAdmin(actor);
  await assertAssignable(ctx, agentId);
  await writeLead(ctx, actor, await findVisible(ctx, actor, id), { assigned_agent_id: agentId });
}

/** Clears a lead's duplicate flag and records who did it. Admins only. */
export async function resolveDuplicate(ctx: DataContext, actor: Actor, id: number): Promise<void> {
  assertAdmin(actor);
  const before = await findVisible(ctx, actor, id);
  if (!before.is_duplicate) return;
  await writeLead(ctx, actor, before, {
    is_duplicate: false,
    duplicate_label: "",
    duplicate_resolved_at: now(),
    duplicate_resolved_by: actor.id,
  });
}

/** Deletes a lead with its notes and events. Admins only. */
export async function deleteLead(ctx: DataContext, actor: Actor, id: number): Promise<void> {
  assertAdmin(actor);
  const before = await findVisible(ctx, actor, id);
  await ctx.db.batch([
    ctx.db.delete(leads).where(eq(leads.id, id)),
    // The compressed card copy goes with the lead (the R2 photo is kept, as before).
    ctx.db.delete(visitingCardPreviews).where(eq(visitingCardPreviews.path, before.visiting_card_path ?? "")),
    auditInsert(ctx, actor, "leads", id, "DELETE", before, null),
  ]);
}

export type ContactResult = "poc1" | "poc2" | "notes" | "existing";

function isBlankPoc(name: string, phone: string, email: string): boolean {
  return (name.trim() === "" || name.trim().toLowerCase() === "contact person") && phone.trim() === "" && email.trim() === "";
}

const digitsOf = (value: string) => value.replace(/\D/g, "");

/**
 * Adds a contact to a lead: into the first empty POC slot, else as a line in
 * the notes. A contact already on the lead (same name, email or phone) is left alone.
 */
export async function addLeadContact(
  ctx: DataContext,
  actor: Actor,
  id: number,
  contact: { name?: string; designation?: string; phone?: string; email?: string },
): Promise<ContactResult> {
  let name = (contact.name ?? "").trim();
  const designation = (contact.designation ?? "").trim() || DEFAULT_POC_DESIGNATION;
  const phone = (contact.phone ?? "").trim();
  const email = (contact.email ?? "").trim().toLowerCase();
  if (!name && !phone && !email) throw new InvalidInputError("A contact needs a name, phone or email.");
  if (!name) name = "Contact Person";

  const lead = await findVisible(ctx, actor, id);
  const digits = digitsOf(phone).slice(-10);
  const lowerName = name.toLowerCase();
  if (
    (lowerName !== "contact person" && [lead.poc_name, lead.poc2_name].some((n) => n.trim().toLowerCase() === lowerName)) ||
    (email !== "" && [lead.poc_email_id, lead.poc2_email_id].includes(email)) ||
    (digits.length >= 8 && [lead.poc_contact_number, lead.poc2_contact_number].some((n) => digitsOf(n).includes(digits)))
  ) {
    return "existing";
  }
  if (isBlankPoc(lead.poc_name, lead.poc_contact_number, lead.poc_email_id)) {
    await writeLead(ctx, actor, lead, { poc_name: name, poc_designation: designation, poc_contact_number: phone, poc_email_id: email });
    return "poc1";
  }
  if (isBlankPoc(lead.poc2_name, lead.poc2_contact_number, lead.poc2_email_id)) {
    await writeLead(ctx, actor, lead, { poc2_name: name, poc2_designation: designation, poc2_contact_number: phone, poc2_email_id: email });
    return "poc2";
  }
  const reach = [phone, email].filter(Boolean).join(", ");
  const line = `[Additional Contact: ${name} (${designation})${reach ? ` - ${reach}` : ""}]`;
  const notes = lead.notes.trim() === "" ? line : `${lead.notes}\n${line}`;
  if (notes.length > 20000) throw new InvalidInputError("The lead's notes are full. Edit them before adding more contacts.");
  await writeLead(ctx, actor, lead, { notes });
  return "notes";
}

/** Adds a note, signed with the caller's name. */
export async function addLeadNote(ctx: DataContext, actor: Actor, leadId: number, content: string): Promise<LeadNote> {
  const text = content.trim();
  if (!text) throw new InvalidInputError("Write a note first.");
  if (text.length > 5000) throw new InvalidInputError("Keep notes under 5000 characters.");
  await findVisible(ctx, actor, leadId);
  const [note] = await ctx.db
    .insert(leadNotes)
    .values({ lead_id: leadId, content: text, agent_id: actor.id, agent_name: actor.full_name })
    .returning();
  return note;
}

/** Deletes a note. Admins only. */
export async function deleteLeadNote(ctx: DataContext, actor: Actor, noteId: number): Promise<void> {
  assertAdmin(actor);
  const note = await ctx.db.query.leadNotes.findFirst({ where: eq(leadNotes.id, noteId) });
  if (!note) return;
  await ctx.db.batch([
    ctx.db.delete(leadNotes).where(eq(leadNotes.id, noteId)),
    auditInsert(ctx, actor, "lead_notes", noteId, "DELETE", note, null),
  ]);
}

// --- Contact log ------------------------------------------------------------

/** Records a Call, WhatsApp or Email press on a lead the caller can see. */
export async function logLeadContact(
  ctx: DataContext,
  actor: Actor,
  leadId: number,
  channel: unknown,
  withDraft = false,
): Promise<void> {
  if (!isContactChannel(channel)) throw new InvalidInputError("Unknown contact channel.");
  await findVisible(ctx, actor, leadId);
  await ctx.db
    .insert(leadContactLogs)
    .values({ lead_id: leadId, agent_id: actor.id, agent_name: actor.full_name, channel, with_draft: withDraft });
}

/** The latest contact presses on a lead the caller can see, newest first. */
export async function getLeadContactLog(
  ctx: DataContext,
  actor: Actor,
  leadId: number,
  limit = 20,
): Promise<LeadContactLog[]> {
  await findVisible(ctx, actor, leadId);
  return ctx.db
    .select()
    .from(leadContactLogs)
    .where(eq(leadContactLogs.lead_id, leadId))
    .orderBy(desc(leadContactLogs.created_at), desc(leadContactLogs.id))
    .limit(limit);
}

// --- Unread notes from teammates ---------------------------------------------

function unreadWhere(actor: Actor, leadId?: number | null) {
  return and(
    or(isNull(leadNotes.agent_id), ne(leadNotes.agent_id, actor.id)),
    sql`not exists (select 1 from ${leadNoteReads} r where r.note_id = ${leadNotes.id} and r.user_id = ${actor.id})`,
    leadId ? eq(leadNotes.lead_id, leadId) : undefined,
    scope(actor),
  );
}

export type UnreadNote = {
  id: number;
  lead_id: number;
  client_name: string;
  agent_id: string | null;
  agent_name: string;
  content: string;
  created_at: string;
};

/** Teammates' notes on the caller's leads that the caller has not read, newest first. */
export async function unreadLeadNotes(ctx: DataContext, actor: Actor, limit = 50): Promise<UnreadNote[]> {
  return unreadLeadNotesQuery(ctx, actor, limit);
}

/** The query behind unreadLeadNotes, for callers that batch it with others. */
export function unreadLeadNotesQuery(ctx: DataContext, actor: Actor, limit = 50) {
  return ctx.db
    .select({
      id: leadNotes.id,
      lead_id: leadNotes.lead_id,
      client_name: leads.client_name,
      agent_id: leadNotes.agent_id,
      agent_name: leadNotes.agent_name,
      content: leadNotes.content,
      created_at: leadNotes.created_at,
    })
    .from(leadNotes)
    .innerJoin(leads, eq(leads.id, leadNotes.lead_id))
    .where(unreadWhere(actor))
    .orderBy(desc(leadNotes.created_at), desc(leadNotes.id))
    .limit(Math.min(Math.max(limit, 1), 200));
}

export async function countUnreadLeadNotes(ctx: DataContext, actor: Actor): Promise<number> {
  const [row] = await countUnreadLeadNotesQuery(ctx, actor);
  return row?.n ?? 0;
}

/** The query behind countUnreadLeadNotes, for callers that batch it with others. */
export function countUnreadLeadNotesQuery(ctx: DataContext, actor: Actor) {
  return ctx.db
    .select({ n: count().as("n") })
    .from(leadNotes)
    .innerJoin(leads, eq(leads.id, leadNotes.lead_id))
    .where(unreadWhere(actor));
}

/** Marks teammates' notes as read, on one lead or all. Returns how many. */
export async function markLeadNotesRead(ctx: DataContext, actor: Actor, leadId: number | null = null): Promise<number> {
  const unread = await ctx.db
    .select({ id: leadNotes.id })
    .from(leadNotes)
    .innerJoin(leads, eq(leads.id, leadNotes.lead_id))
    .where(unreadWhere(actor, leadId));
  if (unread.length === 0) return 0;
  // D1 caps bound parameters per statement; insert in chunks.
  const ids = unread.map((n) => n.id);
  const statements: BatchItem<"sqlite">[] = [];
  for (let i = 0; i < ids.length; i += 40) {
    statements.push(
      ctx.db
        .insert(leadNoteReads)
        .values(ids.slice(i, i + 40).map((note_id) => ({ note_id, user_id: actor.id })))
        .onConflictDoNothing(),
    );
  }
  await ctx.db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return ids.length;
}


