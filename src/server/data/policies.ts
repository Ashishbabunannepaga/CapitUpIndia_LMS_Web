import "server-only";

import { and, desc, eq, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import { isIsoDate, todayInBusinessTz } from "@/lib/dates";
import { AWAITING_POLICY_STATUS, isActiveClientStatus, isOneTimeProduct } from "@/lib/domain";
import { policyYear } from "@/lib/codes";
import { checkPolicy, cleanPolicyReading, hasDifferences, type PolicyCheck, type PolicyReading, type PolicyValues } from "@/lib/policy-check";

import { leadTransactions, leads } from "../db/schema";
import { isAdmin, type Actor } from "./actor";
import { auditInsert } from "./audit";
import type { DataContext } from "./context";
import { InvalidInputError } from "./errors";
import { clientIdentity, closedYearTitle, leadChangeStatements, type Lead } from "./leads";
import { storePolicyDoc, type LeadTransaction, type PolicyFile } from "./transactions";

// Closing a lead with its policy: upload, read, check, confirm.
//
// 1. uploadPolicy stores the file (private R2) as a "pending" Policy history
//    row and moves the lead to Closed Awaiting Policy (a client renewing
//    stays Closed Won or Auto Renewed until the new year is confirmed).
// 2. The action reads it with AI and saves the reading (savePolicyReading).
// 3. confirmPolicy checks the policy against the lead and the agent's values
//    (src/lib/policy-check.ts, plain rules), and only then makes the lead
//    Closed Won: client code for the policy year, renewal date = the policy's
//    end date (none for Travel), last year's due date kept on the calendar,
//    all in one transaction. Differences must be acknowledged and are kept
//    on the row for admins to see.
// Agents can't set Closed Won any other way (assertStatusAllowed in leads.ts).

const NOT_FOUND = "That lead no longer exists or isn't yours.";
const NO_UPLOAD = "That policy upload is no longer waiting to be confirmed. Upload it again.";

async function visibleLead(ctx: DataContext, actor: Actor, leadId: number): Promise<Lead> {
  const lead = await ctx.db.query.leads.findFirst({
    where: and(eq(leads.id, leadId), isAdmin(actor) ? undefined : eq(leads.assigned_agent_id, actor.id)),
  });
  if (!lead) throw new InvalidInputError(NOT_FOUND);
  return lead;
}

async function pendingRow(ctx: DataContext, actor: Actor, cycleId: number): Promise<{ row: LeadTransaction; lead: Lead }> {
  const row = await ctx.db.query.leadTransactions.findFirst({ where: eq(leadTransactions.id, cycleId) });
  if (!row || row.verification !== "pending") throw new InvalidInputError(NO_UPLOAD);
  const lead = await visibleLead(ctx, actor, row.lead_id);
  return { row, lead };
}

/** The values as the agent typed them, checked for shape (all optional at upload). */
export function cleanPolicyValues(input: Partial<Record<keyof PolicyValues, unknown>>): PolicyValues {
  const date = (v: unknown, label: string) => {
    if (v === undefined || v === null || v === "") return "";
    if (!isIsoDate(v)) throw new InvalidInputError(`Pick a valid ${label}.`);
    return v;
  };
  const amount = (v: unknown, label: string) => {
    if (v === undefined || v === null || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s₹]/g, ""));
    if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new InvalidInputError(`Enter the ${label} as a number.`);
    return Math.round(n * 100) / 100;
  };
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  return {
    policy_start_date: date(input.policy_start_date, "policy start date"),
    policy_end_date: date(input.policy_end_date, "policy end date"),
    premium: amount(input.premium, "premium"),
    sum_insured: amount(input.sum_insured, "sum insured"),
    insurer: text(input.insurer, 200),
    policy_number: text(input.policy_number, 100),
  };
}

function valuesOf(row: LeadTransaction): PolicyValues {
  return {
    policy_start_date: row.policy_start_date ?? "",
    policy_end_date: row.policy_end_date ?? "",
    premium: row.premium,
    sum_insured: row.sum_insured,
    insurer: row.insurer,
    policy_number: row.policy_number,
  };
}

export function readingOf(row: Pick<LeadTransaction, "extracted">): PolicyReading | null {
  return row.extracted && typeof row.extracted === "object" ? cleanPolicyReading(row.extracted as Record<string, unknown>) : null;
}

/**
 * Stores an uploaded policy on a lead the caller can see as a pending
 * Policy history row (replacing an earlier unconfirmed upload) and marks the
 * lead Closed Awaiting Policy unless it is already a client.
 */
export async function uploadPolicy(
  ctx: DataContext,
  actor: Actor,
  leadId: number,
  file: PolicyFile,
  input: Partial<Record<keyof PolicyValues, unknown>> = {},
): Promise<{ row: LeadTransaction; mime: string }> {
  const before = await visibleLead(ctx, actor, leadId);
  const values = cleanPolicyValues(input);
  const doc = await storePolicyDoc(ctx, leadId, file);
  const stamp = new Date().toISOString();
  const row = {
    lead_id: leadId,
    transaction_date: todayInBusinessTz(),
    policy_start_date: values.policy_start_date || null,
    policy_end_date: values.policy_end_date || null,
    premium: values.premium,
    sum_insured: values.sum_insured,
    insurer: values.insurer,
    policy_number: values.policy_number,
    product: before.policy_product,
    policy_status: "Policy Received" as const,
    kind: before.client_no ? ("renewal" as const) : ("won" as const),
    verification: "pending" as const,
    ...doc,
    created_by: actor.id,
    updated_by: actor.id,
    created_at: stamp,
    updated_at: stamp,
  };
  // Statements built first, so the insert below is the only write before the batch.
  const statusChange =
    !isActiveClientStatus(before.status) && before.status !== AWAITING_POLICY_STATUS
      ? await leadChangeStatements(ctx, actor, before, { status: AWAITING_POLICY_STATUS })
      : [];
  const [inserted] = await ctx.db.insert(leadTransactions).values(row).returning();
  const statements: BatchItem<"sqlite">[] = [
    // One unconfirmed upload per lead: a new one replaces the older one (its file stays in storage).
    ctx.db
      .delete(leadTransactions)
      .where(and(eq(leadTransactions.lead_id, leadId), eq(leadTransactions.verification, "pending"), ne(leadTransactions.id, inserted.id))),
    auditInsert(ctx, actor, "lead_transactions", leadId, "INSERT", null, row),
    ...statusChange,
  ];
  await ctx.db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]).catch(async (error) => {
    await ctx.db.delete(leadTransactions).where(eq(leadTransactions.id, inserted.id));
    throw error;
  });
  return { row: inserted, mime: doc.policy_doc_mime };
}

/** Saves what the AI read from a pending upload; values the agent left empty are filled from it. */
export async function savePolicyReading(ctx: DataContext, actor: Actor, cycleId: number, reading: PolicyReading): Promise<LeadTransaction> {
  const { row } = await pendingRow(ctx, actor, cycleId);
  const fill = {
    policy_start_date: row.policy_start_date || reading.policy_start_date || null,
    policy_end_date: row.policy_end_date || reading.policy_end_date || null,
    premium: row.premium ?? reading.premium,
    sum_insured: row.sum_insured ?? reading.sum_insured,
    insurer: row.insurer || reading.insurer,
    policy_number: row.policy_number || reading.policy_number,
  };
  const [updated] = await ctx.db
    .update(leadTransactions)
    .set({ extracted: reading, ...fill, updated_at: new Date().toISOString() })
    .where(eq(leadTransactions.id, row.id))
    .returning();
  return updated;
}

export type PolicyReview = {
  row: LeadTransaction;
  reading: PolicyReading | null;
  /** Checks of the reading against the lead and the values typed at upload. */
  checks: PolicyCheck[];
  oneTime: boolean;
};

/** A pending upload with its checks, as the confirm dialog shows it. */
export async function reviewPolicy(ctx: DataContext, actor: Actor, cycleId: number, entered?: PolicyValues): Promise<PolicyReview> {
  const { row, lead } = await pendingRow(ctx, actor, cycleId);
  const reading = readingOf(row);
  const values = entered ?? valuesOf(row);
  return { row, reading, checks: checkPolicy(reading, values, lead), oneTime: isOneTimeProduct(lead.policy_product) };
}

/**
 * Confirms a pending upload with the final values: the lead becomes Closed
 * Won for the policy year. Throws when a check differs and the caller did not
 * acknowledge it. Returns the client code it now carries.
 */
export async function confirmPolicy(
  ctx: DataContext,
  actor: Actor,
  cycleId: number,
  input: Partial<Record<keyof PolicyValues, unknown>>,
  acknowledged = false,
): Promise<{ client_code: string }> {
  const { row, lead: before } = await pendingRow(ctx, actor, cycleId);
  const values = cleanPolicyValues(input);
  if (!values.policy_start_date) throw new InvalidInputError("Enter the policy start date.");
  if (!values.policy_end_date) throw new InvalidInputError("Enter the policy end date.");
  if (values.policy_end_date <= values.policy_start_date) throw new InvalidInputError("The policy end date must be after its start date.");

  const reading = readingOf(row);
  const checks = checkPolicy(reading, values, before);
  const differs = hasDifferences(checks);
  if (differs && !acknowledged) {
    throw new InvalidInputError("The policy differs from the lead. Check the differences and tick that you have, or correct the values.");
  }
  const today = todayInBusinessTz();
  const identity = await clientIdentity(ctx, before, policyYear(values.policy_start_date, today));
  const nextRenewal = isOneTimeProduct(before.policy_product) ? null : values.policy_end_date;
  const verification = !reading ? "manual" : differs ? "differences" : "verified";
  const stamp = new Date().toISOString();
  const cycle = {
    ...values,
    policy_start_date: values.policy_start_date,
    policy_end_date: values.policy_end_date,
    product: before.policy_product,
    verification,
    checks,
    client_code: identity.client_code,
    previous_renewal_date: before.renewal_date,
    next_renewal_date: nextRenewal,
    confirmed_at: stamp,
    confirmed_by: actor.id,
    updated_by: actor.id,
    updated_at: stamp,
  } as const;
  const statements = await leadChangeStatements(
    ctx,
    actor,
    before,
    { status: "Closed Won", renewal_date: nextRenewal, ...identity },
    {
      archiveDue: closedYearTitle(row.kind === "renewal" ? "Renewed" : "Won", before, identity.client_code),
      cycle: () => ctx.db.update(leadTransactions).set(cycle).where(eq(leadTransactions.id, row.id)),
    },
  );
  // Nothing about the lead changed (an admin re-confirming the same year): still confirm the row.
  if (statements.length === 0) statements.push(ctx.db.update(leadTransactions).set(cycle).where(eq(leadTransactions.id, row.id)));
  statements.push(auditInsert(ctx, actor, "lead_transactions", before.id, "UPDATE", row as unknown as Record<string, unknown>, { ...row, ...cycle }));
  await ctx.db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return { client_code: identity.client_code };
}

/** Drops an unconfirmed upload (its file stays in storage). The lead keeps its status. */
export async function discardPolicyUpload(ctx: DataContext, actor: Actor, cycleId: number): Promise<void> {
  const { row } = await pendingRow(ctx, actor, cycleId);
  await ctx.db.batch([
    ctx.db.delete(leadTransactions).where(eq(leadTransactions.id, row.id)),
    auditInsert(ctx, actor, "lead_transactions", row.lead_id, "DELETE", row as unknown as Record<string, unknown>, null),
  ]);
}

/** The lead's unconfirmed upload, if any (the lead page offers to finish it). */
export async function pendingPolicyFor(ctx: DataContext, actor: Actor, leadId: number): Promise<LeadTransaction | null> {
  await visibleLead(ctx, actor, leadId);
  const row = await ctx.db.query.leadTransactions.findFirst({
    where: and(eq(leadTransactions.lead_id, leadId), eq(leadTransactions.verification, "pending")),
    orderBy: desc(leadTransactions.id),
  });
  return row ?? null;
}
