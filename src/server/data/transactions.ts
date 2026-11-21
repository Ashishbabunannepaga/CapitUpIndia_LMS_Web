import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";

import { isIsoDate, todayInBusinessTz } from "@/lib/dates";
import { isActiveClientStatus } from "@/lib/domain";
import { sniffImage } from "@/lib/visiting-cards";

import { POLICY_DOC_STATUSES, leadTransactions, leads } from "../db/schema";
import { assertAdmin, isAdmin, type Actor } from "./actor";
import { auditInsert } from "./audit";
import type { DataContext } from "./context";
import { InvalidInputError } from "./errors";

// Policy history rows (see also src/server/data/policies.ts). Transaction details of a won lead: when the deal was done, when
// the policy starts, and whether CapitUp has the policy copy yet. One row per
// policy cycle, so next year's renewal adds a row and last year's stays.
//
// The policy copy (PDF or photo) sits in the private R2 bucket as
// "policies/<lead id>/<random id>.<ext>" and is read only through
// policyDocument(), for someone who can see the lead. Like leads, a
// transaction the caller cannot see behaves as if it did not exist.

export type LeadTransaction = typeof leadTransactions.$inferSelect;
export type PolicyDocStatus = (typeof POLICY_DOC_STATUSES)[number];

/** Server actions take at most 4.4 MB, so policy files stay under 4 MB. */
export const MAX_POLICY_DOC_BYTES = 4 * 1024 * 1024;

const NOT_FOUND = "That lead no longer exists or isn't yours.";

export type TransactionInput = {
  transaction_date: string;
  policy_start_date?: string | null;
  policy_status: string;
};

export type PolicyFile = { bytes: Uint8Array; name: string };

function isPolicyDocStatus(value: unknown): value is PolicyDocStatus {
  return typeof value === "string" && (POLICY_DOC_STATUSES as readonly string[]).includes(value);
}

async function visibleLead(ctx: DataContext, actor: Actor, leadId: number) {
  const lead = await ctx.db.query.leads.findFirst({
    columns: { id: true, status: true, assigned_agent_id: true },
    where: and(eq(leads.id, leadId), isAdmin(actor) ? undefined : eq(leads.assigned_agent_id, actor.id)),
  });
  if (!lead) throw new InvalidInputError(NOT_FOUND);
  return lead;
}

/** The type of a policy file, from its bytes (never from the browser). */
export function sniffPolicyDoc(bytes: Uint8Array): { mime: string; ext: string } | null {
  // "%PDF-"
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return { mime: "application/pdf", ext: "pdf" };
  }
  return sniffImage(bytes);
}

function checkedInput(input: TransactionInput) {
  if (!isIsoDate(input.transaction_date)) throw new InvalidInputError("Pick the transaction date.");
  if (input.transaction_date > todayInBusinessTz()) throw new InvalidInputError("The transaction date can't be in the future.");
  const start = input.policy_start_date || null;
  if (start !== null && !isIsoDate(start)) throw new InvalidInputError("Pick a valid policy start date.");
  if (!isPolicyDocStatus(input.policy_status)) throw new InvalidInputError("Pick Policy Received or Policy Yet to Receive.");
  return { transaction_date: input.transaction_date, policy_start_date: start, policy_status: input.policy_status };
}

/** Cleans a file name for display (the stored file gets a random name). */
function displayName(name: string, ext: string): string {
  const base = name.replace(/[\\/\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
  return base || `policy.${ext}`;
}

export async function storePolicyDoc(ctx: DataContext, leadId: number, file: PolicyFile) {
  if (file.bytes.byteLength === 0) throw new InvalidInputError("The policy file is empty.");
  if (file.bytes.byteLength > MAX_POLICY_DOC_BYTES) throw new InvalidInputError("Use a policy file under 4 MB.");
  const type = sniffPolicyDoc(file.bytes);
  if (!type) throw new InvalidInputError("Upload the policy as a PDF, JPEG, PNG or WebP file.");
  const path = `policies/${leadId}/${crypto.randomUUID()}.${type.ext}`;
  await ctx.cards.put(path, file.bytes, { httpMetadata: { contentType: type.mime } });
  return { policy_doc_path: path, policy_doc_name: displayName(file.name, type.ext), policy_doc_mime: type.mime };
}

/** A lead's transactions, newest first. Empty for a lead the caller cannot see. */
export async function listLeadTransactions(ctx: DataContext, actor: Actor, leadId: number): Promise<LeadTransaction[]> {
  const lead = await ctx.db.query.leads.findFirst({
    columns: { id: true },
    where: and(eq(leads.id, leadId), isAdmin(actor) ? undefined : eq(leads.assigned_agent_id, actor.id)),
  });
  if (!lead) return [];
  return ctx.db
    .select()
    .from(leadTransactions)
    .where(eq(leadTransactions.lead_id, leadId))
    .orderBy(desc(leadTransactions.transaction_date), desc(leadTransactions.id));
}

/**
 * Adds a transaction to a won or renewed lead the caller can see, or (with
 * `id`) changes one. A policy file can be attached only once the policy is
 * received; marking it "yet to receive" again detaches the file (the copy
 * stays in storage, like replaced visiting cards).
 */
export async function saveLeadTransaction(
  ctx: DataContext,
  actor: Actor,
  leadId: number,
  input: TransactionInput & { id?: number | null },
  file?: PolicyFile | null,
): Promise<LeadTransaction> {
  const lead = await visibleLead(ctx, actor, leadId);
  if (!isActiveClientStatus(lead.status)) {
    throw new InvalidInputError("Policy details are for Closed Won or Auto Renewed leads. Upload the policy to close the lead first.");
  }
  const values = checkedInput(input);
  if (file && values.policy_status !== "Policy Received") {
    throw new InvalidInputError("Mark the policy as received before uploading it.");
  }

  let before: LeadTransaction | undefined;
  if (input.id) {
    before = await ctx.db.query.leadTransactions.findFirst({
      where: and(eq(leadTransactions.id, input.id), eq(leadTransactions.lead_id, leadId)),
    });
    if (!before) throw new InvalidInputError("That transaction no longer exists.");
  }
  const doc = file ? await storePolicyDoc(ctx, leadId, file) : null;
  const detach = values.policy_status !== "Policy Received" ? { policy_doc_path: null, policy_doc_name: "", policy_doc_mime: null } : {};
  const stamp = new Date().toISOString();

  if (before) {
    const after = { ...before, ...values, ...detach, ...(doc ?? {}), updated_by: actor.id, updated_at: stamp };
    const [[row]] = await ctx.db.batch([
      ctx.db.update(leadTransactions).set(after).where(eq(leadTransactions.id, before.id)).returning(),
      auditInsert(ctx, actor, "lead_transactions", before.id, "UPDATE", { ...before, lead_id: leadId }, after),
    ]);
    return row;
  }
  const row = { lead_id: leadId, ...values, ...(doc ?? {}), created_by: actor.id, updated_by: actor.id, created_at: stamp, updated_at: stamp };
  const [[inserted]] = await ctx.db.batch([
    ctx.db.insert(leadTransactions).values(row).returning(),
    auditInsert(ctx, actor, "lead_transactions", leadId, "INSERT", null, row),
  ]);
  return inserted;
}

/** Removes a transaction (its file stays in storage). Admins only. */
export async function deleteLeadTransaction(ctx: DataContext, actor: Actor, id: number): Promise<void> {
  assertAdmin(actor);
  const before = await ctx.db.query.leadTransactions.findFirst({ where: eq(leadTransactions.id, id) });
  if (!before) return;
  await ctx.db.batch([
    ctx.db.delete(leadTransactions).where(eq(leadTransactions.id, id)),
    auditInsert(ctx, actor, "lead_transactions", before.lead_id, "DELETE", before, null),
  ]);
}

export type PolicyDocument = { body: ReadableStream; contentType: string; name: string };

/** The policy file of a transaction on a lead the caller can see, or null. */
export async function policyDocument(ctx: DataContext, actor: Actor, transactionId: number): Promise<PolicyDocument | null> {
  const [row] = await ctx.db
    .select({ path: leadTransactions.policy_doc_path, name: leadTransactions.policy_doc_name, mime: leadTransactions.policy_doc_mime })
    .from(leadTransactions)
    .innerJoin(leads, eq(leads.id, leadTransactions.lead_id))
    .where(and(eq(leadTransactions.id, transactionId), isAdmin(actor) ? undefined : eq(leads.assigned_agent_id, actor.id)))
    .limit(1);
  if (!row?.path) return null;
  const object = await ctx.cards.get(row.path);
  if (!object) return null;
  return { body: object.body, contentType: row.mime ?? object.httpMetadata?.contentType ?? "application/octet-stream", name: row.name };
}

/** The newest transaction of each lead, for exports. */
export async function latestTransactions(ctx: DataContext, leadIds: number[]): Promise<Map<number, LeadTransaction>> {
  const out = new Map<number, LeadTransaction>();
  for (let i = 0; i < leadIds.length; i += 90) {
    const rows = await ctx.db
      .select()
      .from(leadTransactions)
      .where(inArray(leadTransactions.lead_id, leadIds.slice(i, i + 90)))
      .orderBy(desc(leadTransactions.transaction_date), desc(leadTransactions.id));
    for (const row of rows) if (!out.has(row.lead_id)) out.set(row.lead_id, row);
  }
  return out;
}
