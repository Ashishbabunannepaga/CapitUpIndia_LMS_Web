"use server";

import { revalidatePath } from "next/cache";

import { friendlyError } from "@/lib/action-errors";
import { AiRateLimitError, AiUnavailableError, generate, parseJsonObject } from "@/lib/ai/client";
import { MAX_OUTPUT_TOKENS, MODEL_CHAINS } from "@/lib/ai/models";
import { policyDocumentPrompt } from "@/lib/ai/prompts";
import { policySchema } from "@/lib/ai/schemas";
import { getSession } from "@/lib/auth";
import { cleanPolicyReading, type PolicyCheck, type PolicyReading, type PolicyValues } from "@/lib/policy-check";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/upload-limits";
import * as policyData from "@/server/data/policies";

// Closing a lead with its policy (see src/server/data/policies.ts):
// uploadPolicy stores the file and reads it, confirmPolicy closes the lead.

export type PolicyReviewResult =
  | {
      ok: true;
      cycleId: number;
      /** What was read from the document, or null when it could not be read. */
      reading: PolicyReading | null;
      /** The values to confirm: the agent's, with gaps filled from the reading. */
      values: PolicyValues;
      checks: PolicyCheck[];
      oneTime: boolean;
      notice?: string;
    }
  | { ok: false; error: string };

const SIGNED_OUT = { ok: false, error: "Your session has ended. Sign in again." } as const;

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function valuesFrom(formData: FormData) {
  return {
    policy_start_date: field(formData, "policy_start_date"),
    policy_end_date: field(formData, "policy_end_date"),
    premium: field(formData, "premium"),
    sum_insured: field(formData, "sum_insured"),
    insurer: field(formData, "insurer"),
    policy_number: field(formData, "policy_number"),
  };
}

function rowValues(row: policyData.PolicyReview["row"]): PolicyValues {
  return {
    policy_start_date: row.policy_start_date ?? "",
    policy_end_date: row.policy_end_date ?? "",
    premium: row.premium,
    sum_insured: row.sum_insured,
    insurer: row.insurer,
    policy_number: row.policy_number,
  };
}

/**
 * Uploads a lead's policy (form fields: policy_doc, and optionally the
 * agent's policy_start_date, policy_end_date, premium, policy_number), moves
 * the lead to Closed Awaiting Policy, reads the document with AI and returns
 * the checks for the agent to review. Nothing is closed yet.
 */
export async function uploadPolicy(leadId: number, formData: FormData): Promise<PolicyReviewResult> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  const { ctx, actor } = session;
  const file = formData.get("policy_doc");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose the policy file (PDF or photo)." };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: `The policy file is larger than ${MAX_UPLOAD_LABEL}.` };
  const bytes = new Uint8Array(await file.arrayBuffer());

  let uploaded: Awaited<ReturnType<typeof policyData.uploadPolicy>>;
  try {
    uploaded = await policyData.uploadPolicy(ctx, actor, leadId, { bytes, name: file.name }, valuesFrom(formData));
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
  revalidatePath("/", "layout");

  let notice: string | undefined;
  try {
    const base64 = Buffer.from(bytes).toString("base64");
    const { value } = await generate({
      ctx,
      user: actor,
      feature: "policy_ocr",
      models: MODEL_CHAINS.vision,
      system: policyDocumentPrompt(),
      text: "Read this insurance policy.",
      ...(uploaded.mime === "application/pdf"
        ? { file: { name: "policy.pdf", mime: uploaded.mime, base64 } }
        : { image: { mime: uploaded.mime, base64 } }),
      jsonSchema: policySchema,
      maxOutputTokens: MAX_OUTPUT_TOKENS.policy,
      parse: parseJsonObject,
    });
    await policyData.savePolicyReading(ctx, actor, uploaded.row.id, cleanPolicyReading(value));
  } catch (error) {
    if (error instanceof AiUnavailableError || error instanceof AiRateLimitError) {
      notice = `${error.message} The policy is saved; type its details and confirm them yourself. It will be marked "checked by hand".`;
    } else {
      console.error("Policy reading failed", error instanceof Error ? error.message : error);
      notice = 'The policy could not be read automatically. Type its details and confirm them; it will be marked "checked by hand".';
    }
  }

  try {
    const review = await policyData.reviewPolicy(ctx, actor, uploaded.row.id);
    return {
      ok: true,
      cycleId: review.row.id,
      reading: review.reading,
      values: rowValues(review.row),
      checks: review.checks,
      oneTime: review.oneTime,
      notice,
    };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}

/** Re-runs the checks for values the agent changed in the review dialog (nothing is saved). */
export async function recheckPolicy(cycleId: number, formData: FormData): Promise<PolicyReviewResult> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  try {
    const values = policyData.cleanPolicyValues(valuesFrom(formData));
    const review = await policyData.reviewPolicy(session.ctx, session.actor, cycleId, values);
    return { ok: true, cycleId, reading: review.reading, values, checks: review.checks, oneTime: review.oneTime };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}

/** Opens an earlier unconfirmed upload for review again. */
export async function resumePolicyReview(cycleId: number): Promise<PolicyReviewResult> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  try {
    const review = await policyData.reviewPolicy(session.ctx, session.actor, cycleId);
    return { ok: true, cycleId, reading: review.reading, values: rowValues(review.row), checks: review.checks, oneTime: review.oneTime };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}

/** Confirms the reviewed policy: the lead becomes Closed Won with its client code. */
export async function confirmPolicy(
  cycleId: number,
  formData: FormData,
): Promise<{ ok: true; clientCode: string } | { ok: false; error: string }> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  try {
    const acknowledged = formData.get("acknowledged") === "on" || formData.get("acknowledged") === "true";
    const { client_code } = await policyData.confirmPolicy(session.ctx, session.actor, cycleId, valuesFrom(formData), acknowledged);
    revalidatePath("/", "layout");
    return { ok: true, clientCode: client_code };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}

/** Drops an unconfirmed upload; the lead stays Closed Awaiting Policy. */
export async function discardPolicyUpload(cycleId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  try {
    await policyData.discardPolicyUpload(session.ctx, session.actor, cycleId);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}
