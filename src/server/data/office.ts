import "server-only";

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { leads, profiles } from "../db/schema";
import {
  OfficeError,
  type GapCounts,
  type OfficeClient,
  type OfficeConsent,
  type OfficeConversation,
  type OfficeGame,
  type OfficeLead,
  type OfficePage,
  type OfficePolicy,
  type OfficeRenewal,
  type OfficeSource,
  type OfficeStats,
} from "../office/portal";
import { assertAdmin, isAdmin, type Actor } from "./actor";
import { auditInsert } from "./audit";
import type { DataContext } from "./context";
import { AccessDeniedError, InvalidInputError } from "./errors";
import { createLead } from "./leads";
import { isReport, stripSummary } from "@/lib/office-report";

// The capitupindia.com/office console inside the LMS.
//
// Data ownership: visitors' uploads, gap reports and call requests stay in the
// Capitup AI site's own database, where the public site writes them; the LMS
// reads and updates them through the office API (src/server/office/portal.ts)
// and copies nothing into D1 except the leads an admin hands to an agent.
//
// Access (Ash, 2026-11-04): admins work the office. They see every call
// request, renewal, report and policy file, update follow-up and renewal
// status, and hand a client to an agent, which creates an ordinary LMS lead
// assigned to that agent. Agents get the portal's counts only, never client
// names or contact details, and work handed-over clients as their own leads.

export const OFFICE_LEAD_STATUSES = ["new", "contacted", "follow_up", "converted", "closed"] as const;
export const OFFICE_RENEWAL_STATUSES = ["to_contact", "contacted", "quoted", "renewed", "lost"] as const;

export type OfficeOverview = {
  portalUrl: string;
  state: "ok" | "not-configured" | "error";
  message?: string;
  fetchedAt?: string;
  stats?: OfficeStats;
  /** Admins only; undefined for agents. */
  renewals?: OfficeRenewal[];
};

/** Where a handed-over call request went in the LMS. */
export type OfficeHandoff = { leadId: number; agentName: string | null };

const ID = /^[0-9a-f-]{36}$/i;
const CURSOR = /^[A-Za-z0-9_=-]{1,400}$/;

function officeId(value: unknown, what = "item"): string {
  if (typeof value !== "string" || !ID.test(value)) throw new InvalidInputError(`That office ${what} link is not valid.`);
  return value.toLowerCase();
}

function cursorQuery(cursor: string | null | undefined): string {
  if (!cursor) return "";
  if (!CURSOR.test(cursor)) throw new InvalidInputError("That page link is not valid.");
  return `&cursor=${encodeURIComponent(cursor)}`;
}

/** Office failures reach the user as plain messages, like any other invalid action. */
async function office<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof OfficeError) throw new InvalidInputError(error.message);
    throw error;
  }
}

// Fields the LMS never shows or needs: the visitor's IP address and session id.
function cleanLead(row: OfficeLead & Record<string, unknown>): OfficeLead {
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    phone: row.phone ?? null,
    message: row.message ?? "",
    preferred_time: row.preferred_time ?? null,
    timezone: row.timezone ?? null,
    source: row.source,
    conversation_id: row.conversation_id ?? null,
    marketing_opt_in: Boolean(row.marketing_opt_in),
    status: row.status || "new",
    notes: row.notes ?? "",
    handled_by: row.handled_by ?? null,
    status_changed_at: row.status_changed_at ?? null,
    created_at: row.created_at,
  };
}

// Never passed on: the visitor's IP and session, the policy text and storage key.
const POLICY_HIDDEN = new Set(["ip", "visitor_id", "text", "object_key", "page_details", "ocr_job", "consents"]);

function cleanPolicy(row: OfficePolicy & Record<string, unknown>): OfficePolicy {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !POLICY_HIDDEN.has(key))) as OfficePolicy;
}

function cleanConsents(rows: unknown): OfficeConsent[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((c: Record<string, unknown>) => ({
    purpose: String(c.purpose ?? ""),
    accepted: Boolean(c.accepted),
    marketing: Boolean(c.marketing),
    created_at: String(c.created_at ?? ""),
  }));
}

// --- Overview ----------------------------------------------------------------

export async function officeOverview(source: OfficeSource, actor: Actor): Promise<OfficeOverview> {
  const result = await source.read(false);
  const base = { portalUrl: source.portalUrl };
  if (result.status !== "ok") {
    return { ...base, state: result.status, message: result.status === "error" ? result.message : undefined };
  }
  const { stats, renewals, fetchedAt } = result.snapshot;
  if (isAdmin(actor)) {
    return { ...base, state: "ok", fetchedAt, stats: { ...stats, recent_leads: (stats.recent_leads ?? []).map((l) => cleanLead(l)) }, renewals };
  }
  const counts: OfficeStats = { ...stats };
  delete counts.recent_leads; // names and phone numbers
  return { ...base, state: "ok", fetchedAt, stats: counts, renewals: undefined };
}

/** Admins can fetch a fresh copy now instead of waiting for the cache. */
export async function refreshOffice(source: OfficeSource, actor: Actor): Promise<void> {
  assertAdmin(actor);
  await source.read(true);
}

// --- Call requests -----------------------------------------------------------

async function handoffs(ctx: DataContext, officeLeadIds: string[]): Promise<Record<string, OfficeHandoff>> {
  if (officeLeadIds.length === 0) return {};
  const rows = await ctx.db
    .select({ id: leads.id, office_lead_id: leads.office_lead_id, agent: profiles.full_name })
    .from(leads)
    .leftJoin(profiles, eq(profiles.id, leads.assigned_agent_id))
    .where(and(isNotNull(leads.office_lead_id), inArray(leads.office_lead_id, officeLeadIds)));
  return Object.fromEntries(rows.map((r) => [r.office_lead_id as string, { leadId: r.id, agentName: r.agent ?? null }]));
}

export type CallRequestPage = OfficePage<OfficeLead> & { handoffs: Record<string, OfficeHandoff> };

/** Call requests, newest first, 100 per page. */
export async function listCallRequests(
  source: OfficeSource,
  ctx: DataContext,
  actor: Actor,
  cursor?: string | null,
): Promise<CallRequestPage> {
  assertAdmin(actor);
  const page = await office(() => source.get<OfficePage<OfficeLead>>(`/api/admin/leads?limit=100${cursorQuery(cursor)}`));
  const items = (page.items ?? []).map((l) => cleanLead(l as OfficeLead & Record<string, unknown>));
  return { items, next_cursor: page.next_cursor ?? null, handoffs: await handoffs(ctx, items.map((i) => i.id)) };
}

export type CallRequestDetail = OfficeClient & { handoff: OfficeHandoff | null };

/** One call request with everything the same visitor shared. */
export async function getCallRequest(source: OfficeSource, ctx: DataContext, actor: Actor, id: unknown): Promise<CallRequestDetail> {
  assertAdmin(actor);
  const leadId = officeId(id, "call request");
  const data = await office(() => source.get<OfficeClient>(`/api/admin/clients/${leadId}`));
  const lead = cleanLead(data.lead as OfficeLead & Record<string, unknown>);
  return {
    lead,
    policies: (data.policies ?? []).map((p) => cleanPolicy(p as OfficePolicy & Record<string, unknown>)),
    other_requests: (data.other_requests ?? []).map((l) => cleanLead(l as OfficeLead & Record<string, unknown>)),
    games: (data.games ?? []).map(({ id: gameId, answers, result, version, created_at }) => ({ id: gameId, answers, result, version, created_at })),
    handoff: (await handoffs(ctx, [lead.id]))[lead.id] ?? null,
  };
}

const callRequestUpdate = z
  .object({
    status: z.enum(OFFICE_LEAD_STATUSES).optional(),
    notes: z.string().max(4000, "Notes can be at most 4,000 characters.").optional(),
  })
  .refine((v) => v.status !== undefined || v.notes !== undefined, "Nothing to change.");

/** Follow-up status and team notes on a call request, written to the office and audited here. */
export async function updateCallRequest(
  source: OfficeSource,
  ctx: DataContext,
  actor: Actor,
  id: unknown,
  input: unknown,
): Promise<OfficeLead> {
  assertAdmin(actor);
  const leadId = officeId(id, "call request");
  const parsed = callRequestUpdate.safeParse(input);
  if (!parsed.success) throw new InvalidInputError(parsed.error.issues[0]?.message ?? "Check the change.");
  const updated = await office(() => source.send<OfficeLead>("PATCH", `/api/admin/leads/${leadId}`, parsed.data));
  await auditInsert(ctx, actor, "office_call_requests", leadId, "UPDATE", null, parsed.data);
  return cleanLead(updated as OfficeLead & Record<string, unknown>);
}

// --- Hand-over to an agent -----------------------------------------------------

const PRODUCT: Record<string, "Health" | "Motor" | "Life"> = { health: "Health", motor: "Motor", life: "Life" };
const SOURCE_LABEL: Record<string, string> = {
  policy: "gap report",
  whatsapp: "report on WhatsApp",
  appointment: "book-a-call page",
  contact: "contact form",
  game: "protection game",
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function gapLine(gaps: GapCounts | null | undefined): string | null {
  if (!gaps) return null;
  const parts = (["HIGH", "MEDIUM", "LOW"] as const).filter((l) => gaps[l] > 0).map((l) => `${gaps[l]} ${l.toLowerCase()}`);
  return parts.length ? `Gap report: ${parts.join(", ")} priority gaps.` : "Gap report: no gaps flagged.";
}

/** The LMS lead fields for an office client. Individuals from the website are Retail. */
export function leadFromOffice(client: Pick<OfficeClient, "lead" | "policies">, today = new Date().toISOString().slice(0, 10)) {
  const { lead, policies } = client;
  // The policy to renew: the next expiry from today, else the latest one, else the newest upload.
  const dated = policies.filter((p) => p.expires_on).sort((a, b) => String(a.expires_on).localeCompare(String(b.expires_on)));
  const policy = dated.find((p) => String(p.expires_on) >= today) ?? dated[dated.length - 1] ?? policies[0];
  const email = lead.email?.trim() ?? "";
  const notes = [
    `From capitupindia.com: call request via the ${SOURCE_LABEL[lead.source] ?? "website"} on ${lead.created_at.slice(0, 10)}.`,
    lead.message?.trim() ? `What they want to discuss: ${lead.message.trim()}` : null,
    lead.preferred_time ? `Best time to call: ${[lead.preferred_time, lead.timezone].filter(Boolean).join(" ")}` : null,
    policy ? `Policy shared: ${policy.filename}${policy.expires_on ? `, ends ${policy.expires_on}` : ""}.` : null,
    gapLine(policy?.gaps),
    lead.marketing_opt_in ? "Agreed to receive updates." : "Contact only about this request (no marketing).",
    lead.notes?.trim() ? `Office notes: ${lead.notes.trim()}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    client_name: lead.name.trim().slice(0, 300) || "Website client",
    type: (policy?.expires_on ? "Renewal" : "New") as "Renewal" | "New",
    business_type: "Retail" as const,
    policy_product: PRODUCT[policy?.policy_type ?? ""] ?? ("Health" as const),
    renewal_date: policy?.expires_on ?? null,
    poc_name: lead.name.trim().slice(0, 120),
    poc_contact_number: (lead.phone ?? "").trim().slice(0, 32),
    poc_email_id: EMAIL.test(email) ? email.slice(0, 254) : "",
    notes: notes.slice(0, 20000),
    status: "Prospect" as const,
  };
}

export type HandoffResult = { leadId: number; duplicate: boolean; officeNoted: boolean };

/**
 * Turns a call request into an LMS lead for an agent (or Unassigned). The new
 * lead goes through the usual duplicate check and renewal reminders; the
 * office request gets a note saying where it went, so nobody calls twice.
 */
export async function handOffCallRequest(
  source: OfficeSource,
  ctx: DataContext,
  actor: Actor,
  id: unknown,
  agentId: string | null,
): Promise<HandoffResult> {
  assertAdmin(actor);
  const detail = await getCallRequest(source, ctx, actor, id);
  if (detail.handoff) throw new InvalidInputError(`This call request is already LMS lead #${detail.handoff.leadId}.`);
  const agent = agentId ? await ctx.db.query.profiles.findFirst({ where: eq(profiles.id, agentId) }) : null;
  if (agentId && !agent?.is_active) throw new InvalidInputError("Pick an active team member.");

  let leadId: number;
  try {
    leadId = await createLead(ctx, actor, { ...leadFromOffice(detail), assigned_agent_id: agentId, office_lead_id: detail.lead.id });
  } catch (error) {
    if (String(error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : error).includes("leads_office_lead_id_idx") ||
        String(error).includes("UNIQUE")) {
      throw new InvalidInputError("This call request was just handed over by someone else.");
    }
    throw error;
  }
  const created = await ctx.db.query.leads.findFirst({ where: eq(leads.id, leadId) });

  const stamp = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  const line = `[LMS] Handed to ${agent?.full_name ?? "Unassigned"} as LMS lead #${leadId} by ${actor.full_name}, ${stamp}.`;
  const notes = [detail.lead.notes.trim(), line].filter(Boolean).join("\n");
  let officeNoted = false;
  if (notes.length <= 4000) {
    try {
      await source.send("PATCH", `/api/admin/leads/${detail.lead.id}`, { notes });
      officeNoted = true;
    } catch (error) {
      console.error("Office note after hand-over failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { leadId, duplicate: Boolean(created?.is_duplicate), officeNoted };
}

// --- Renewals ------------------------------------------------------------------

export async function listOfficeRenewals(source: OfficeSource, actor: Actor): Promise<OfficeRenewal[]> {
  assertAdmin(actor);
  const result = await source.read(false);
  if (result.status === "not-configured") return [];
  if (result.status === "error") throw new InvalidInputError(result.message);
  return result.snapshot.renewals;
}

const renewalUpdate = z
  .object({
    renewal_status: z.enum(OFFICE_RENEWAL_STATUSES).optional(),
    renewal_note: z.string().max(2000, "A renewal note can be at most 2,000 characters.").optional(),
    expires_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date as YYYY-MM-DD.")
      .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "Enter a real date.")
      .optional(),
  })
  .refine((v) => v.renewal_status !== undefined || v.renewal_note !== undefined || v.expires_on !== undefined, "Nothing to change.");

/** Renewal outreach on a client policy: status, note, or a corrected end date. */
export async function updateOfficeRenewal(
  source: OfficeSource,
  ctx: DataContext,
  actor: Actor,
  policyId: unknown,
  input: unknown,
): Promise<void> {
  assertAdmin(actor);
  const id = officeId(policyId, "policy");
  const parsed = renewalUpdate.safeParse(input);
  if (!parsed.success) throw new InvalidInputError(parsed.error.issues[0]?.message ?? "Check the change.");
  await office(() => source.send("PATCH", `/api/admin/policies/${id}/renewal`, parsed.data));
  await auditInsert(ctx, actor, "office_renewals", id, "UPDATE", null, parsed.data);
}

// --- Policies, reports, files, games --------------------------------------------

export async function listOfficePolicies(source: OfficeSource, actor: Actor, cursor?: string | null): Promise<OfficePage<OfficePolicy>> {
  assertAdmin(actor);
  const page = await office(() => source.get<OfficePage<OfficePolicy>>(`/api/admin/policies?limit=100${cursorQuery(cursor)}`));
  return { items: (page.items ?? []).map((p) => cleanPolicy(p as OfficePolicy & Record<string, unknown>)), next_cursor: page.next_cursor ?? null };
}

export type OfficePolicyDetail = OfficePolicy & {
  pageDetails: { page: number; method: string; engine: string | null; confidence: number | null }[];
};

export async function getOfficePolicy(source: OfficeSource, actor: Actor, id: unknown): Promise<OfficePolicyDetail> {
  assertAdmin(actor);
  const policyId = officeId(id, "policy");
  const raw = await office(() => source.get<OfficePolicy & Record<string, unknown>>(`/api/admin/policies/${policyId}`));
  const pages = Array.isArray(raw.page_details) ? (raw.page_details as Record<string, unknown>[]) : [];
  return {
    ...cleanPolicy(raw),
    pageDetails: pages.map((p) => ({
      page: Number(p.page),
      method: String(p.method ?? ""),
      engine: (p.engine as string | null) ?? null,
      confidence: typeof p.confidence === "number" ? p.confidence : null,
    })),
  };
}

export type OfficeReport = {
  filename: string | null;
  /** The latest gap report shown to the client, without its summary block. */
  report: { content: string; created_at: string } | null;
  consents: OfficeConsent[];
};

/** The gap report a client received. Only the report itself, not the rest of the chat. */
export async function getOfficeReport(source: OfficeSource, actor: Actor, conversationId: unknown): Promise<OfficeReport> {
  assertAdmin(actor);
  const id = officeId(conversationId, "report");
  const conv = await office(() => source.get<OfficeConversation>(`/api/admin/conversations/${id}`));
  const answer = [...(conv.messages ?? [])].reverse().find((m) => m.role === "assistant" && isReport(m.content));
  return {
    filename: conv.policy?.filename ?? null,
    report: answer ? { content: stripSummary(answer.content), created_at: answer.created_at } : null,
    consents: cleanConsents(conv.consents),
  };
}

export async function listOfficeGames(source: OfficeSource, actor: Actor, cursor?: string | null): Promise<OfficePage<OfficeGame>> {
  assertAdmin(actor);
  const page = await office(() => source.get<OfficePage<OfficeGame & Record<string, unknown>>>(`/api/admin/game-results?limit=100${cursorQuery(cursor)}`));
  return {
    items: (page.items ?? []).map(({ id, answers, result, version, created_at }) => ({ id, answers, result, version, created_at })),
    next_cursor: page.next_cursor ?? null,
  };
}

/** A client's uploaded policy file. Audited here as well as in the office. */
export async function downloadOfficePolicy(source: OfficeSource, ctx: DataContext, actor: Actor, id: unknown): Promise<Response> {
  if (!isAdmin(actor)) throw new AccessDeniedError("Only admins can download client policies.");
  const policyId = officeId(id, "policy");
  const file = await office(() => source.download(`/api/admin/policies/${policyId}/download`));
  await auditInsert(ctx, actor, "office_policy_downloads", policyId, "INSERT", null, { downloaded: true });
  return file;
}
