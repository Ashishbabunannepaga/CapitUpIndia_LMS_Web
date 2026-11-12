"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { friendlyError } from "@/lib/action-errors";
import { getSession, isAdmin } from "@/lib/auth";
import type { BusinessType, LeadStatus, LeadType, PolicyProduct } from "@/lib/database.types";
import { isLeadStatus } from "@/lib/domain";
import { businessDateTimeToIso } from "@/lib/dates";
import { contactSchema, formDataToObject, leadFormSchema, meetingSchema, type LeadFormValues } from "@/lib/lead-schema";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/upload-limits";
import { attachCardToLead } from "@/server/data/cards";
import { createTask } from "@/server/data/events";
import { findSimilarLeads, type SimilarLead } from "@/server/data/duplicates";
import { isOwnCardPath } from "@/lib/visiting-cards";
import * as leadData from "@/server/data/leads";

export type { SimilarLead };

export type LeadFormState = {
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
  /** Similar companies found on save; the user must confirm to continue. */
  duplicates?: SimilarLead[];
  values?: Record<string, string>;
};

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const SIGNED_OUT = "Your session has ended. Sign in again.";

function refreshWorkspace() {
  revalidatePath("/", "layout");
}

function toRow(v: LeadFormValues) {
  return {
    client_name: v.client_name,
    type: v.type as LeadType,
    business_type: v.business_type as BusinessType,
    policy_product: v.policy_product as PolicyProduct,
    sub_product_name: v.sub_product_name,
    address: v.address,
    renewal_date: v.renewal_date,
    poc_name: v.poc_name,
    poc_designation: v.poc_designation,
    poc_contact_number: v.poc_contact_number,
    poc_email_id: v.poc_email_id,
    poc2_name: v.poc2_name,
    poc2_designation: v.poc2_designation,
    poc2_contact_number: v.poc2_contact_number,
    poc2_email_id: v.poc2_email_id,
    notes: v.notes,
    relationship_manager: v.relationship_manager,
    status: v.status as LeadStatus,
  };
}

function parseLeadForm(formData: FormData) {
  const raw = formDataToObject(formData);
  const parsed = leadFormSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      fieldErrors[key] ??= issue.message;
    }
    return { ok: false as const, state: { error: "Check the highlighted fields.", fieldErrors, values: raw } };
  }
  return { ok: true as const, values: parsed.data, raw };
}

/** Fuzzy duplicate lookup while the user types a company name. */
export async function checkDuplicates(clientName: string, excludeId?: number): Promise<SimilarLead[]> {
  const session = await getSession();
  if (!session) return [];
  const name = clientName.trim().slice(0, 300);
  if (name.length < 3) return [];
  return findSimilarLeads(session.ctx, session.actor, name, { excludeId });
}

export async function createLead(_prev: LeadFormState, formData: FormData): Promise<LeadFormState> {
  const session = await getSession();
  if (!session) return { error: SIGNED_OUT };
  const { ctx, actor } = session;
  const parsed = parseLeadForm(formData);
  if (!parsed.ok) return parsed.state;
  const { values, raw } = parsed;
  // Checked before the lead is saved, so a bad meeting date never leaves a lead without its meeting.
  const meeting = meetingSchema.safeParse(raw);
  if (!meeting.success) {
    const issue = meeting.error.issues[0];
    return {
      error: "Check the highlighted fields.",
      fieldErrors: { [String(issue?.path[0] ?? "meeting_date")]: issue?.message ?? "Check the meeting." },
      values: raw,
    };
  }

  // Never create a competing company record without an explicit decision.
  const similar = await findSimilarLeads(ctx, actor, values.client_name);
  if (similar.length > 0 && !values.confirm_duplicate) {
    return { duplicates: similar, values: raw };
  }

  let id: number;
  try {
    id = await leadData.createLead(ctx, actor, {
      ...toRow(values),
      // A scanned card is attached only if this user uploaded it.
      visiting_card_path:
        values.visiting_card_path && isOwnCardPath(values.visiting_card_path, actor.id) ? values.visiting_card_path : null,
      // Agents always own what they create; admins choose (or leave unassigned).
      assigned_agent_id: isAdmin(actor) ? values.assigned_agent_id : actor.id,
    });
  } catch (error) {
    return { error: friendlyError(error), values: raw };
  }

  let saved = "created";
  const { meeting_title, meeting_date, meeting_time, meeting_notes } = meeting.data;
  if (meeting_title) {
    try {
      // The meeting is the creator's own, linked to the new lead.
      await createTask(ctx, actor, {
        title: meeting_title,
        kind: "meeting",
        notes: meeting_notes,
        lead_id: id,
        event_timestamp: businessDateTimeToIso(meeting_date, meeting_time || "10:00"),
      });
      saved = "created_meeting";
    } catch {
      // The lead is saved; say so and let them add the meeting on its page.
      saved = "created_no_meeting";
    }
  }

  refreshWorkspace();
  redirect(`/leads/${id}?saved=${saved}`);
}

export async function updateLead(leadId: number, _prev: LeadFormState, formData: FormData): Promise<LeadFormState> {
  const session = await getSession();
  if (!session) return { error: SIGNED_OUT };
  const { ctx, actor } = session;
  const parsed = parseLeadForm(formData);
  if (!parsed.ok) return parsed.state;
  const { values, raw } = parsed;

  try {
    const current = await leadData.getLead(ctx, actor, leadId);
    if (!current) return { error: "That lead no longer exists or isn't yours.", values: raw };

    if (current.client_name.trim().toLowerCase() !== values.client_name.toLowerCase()) {
      const similar = await findSimilarLeads(ctx, actor, values.client_name, { excludeId: leadId });
      if (similar.length > 0 && !values.confirm_duplicate) {
        return { duplicates: similar, values: raw };
      }
    }

    await leadData.updateLead(ctx, actor, leadId, {
      ...toRow(values),
      ...(isAdmin(actor) ? { assigned_agent_id: values.assigned_agent_id } : {}),
    });
  } catch (error) {
    return { error: friendlyError(error), values: raw };
  }

  refreshWorkspace();
  redirect(`/leads/${leadId}?saved=updated`);
}

/**
 * Instead of creating a competing record, add the form's contacts (and note)
 * to a lead the user can already see, using the POC merge rule. The target
 * lead comes from the clicked button (name="merge_into").
 */
export async function mergeIntoExistingLead(_prev: LeadFormState, formData: FormData): Promise<LeadFormState> {
  const session = await getSession();
  if (!session) return { error: SIGNED_OUT };
  const { ctx, actor } = session;
  const parsed = parseLeadForm(formData);
  if (!parsed.ok) return parsed.state;
  const { values, raw } = parsed;
  const targetLeadId = Number(formData.get("merge_into"));
  if (!Number.isInteger(targetLeadId) || targetLeadId <= 0) return { error: "Pick a lead to add to.", values: raw };

  const contacts = [
    [values.poc_name, values.poc_designation, values.poc_contact_number, values.poc_email_id],
    [values.poc2_name, values.poc2_designation, values.poc2_contact_number, values.poc2_email_id],
  ].filter(([name, , phone, email]) => name || phone || email);

  try {
    for (const [name, designation, phone, email] of contacts) {
      await leadData.addLeadContact(ctx, actor, targetLeadId, { name, designation, phone, email });
    }
    if (values.notes) await leadData.addLeadNote(ctx, actor, targetLeadId, values.notes);
  } catch (error) {
    return { error: friendlyError(error), values: raw };
  }

  refreshWorkspace();
  redirect(`/leads/${targetLeadId}?saved=merged`);
}

/** Runs a data call as the signed-in user and refreshes the workspace on success. */
async function run(fn: (session: NonNullable<Awaited<ReturnType<typeof getSession>>>) => Promise<unknown>): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: SIGNED_OUT };
  try {
    await fn(session);
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
  refreshWorkspace();
  return { ok: true };
}

export async function setLeadStatus(leadId: number, status: string): Promise<ActionResult> {
  if (!isLeadStatus(status)) return { ok: false, error: "Unknown status." };
  return run(({ ctx, actor }) => leadData.setLeadStatus(ctx, actor, leadId, status));
}

export async function assignLead(leadId: number, agentId: string | null): Promise<ActionResult> {
  return run(({ ctx, actor }) => leadData.assignLead(ctx, actor, leadId, agentId));
}

/** Logs a Call, WhatsApp or Email press. Fire and forget: a failure never blocks the contact itself. */
export async function logLeadContact(leadId: number, channel: string, withDraft = false): Promise<void> {
  const session = await getSession();
  if (!session) return;
  try {
    await leadData.logLeadContact(session.ctx, session.actor, leadId, channel, withDraft);
    revalidatePath(`/leads/${leadId}`);
  } catch {
    // The lead vanished or the channel is unknown; nothing to record.
  }
}

export async function addLeadNote(leadId: number, content: string): Promise<ActionResult> {
  return run(({ ctx, actor }) => leadData.addLeadNote(ctx, actor, leadId, content));
}

const CONTACT_RESULT_MESSAGES = {
  poc1: "Added as the primary POC.",
  poc2: "Added as the secondary POC.",
  notes: "Both POC slots are taken, so the contact was added to the lead's notes.",
  existing: "This contact is already on the lead.",
} as const;

export async function addLeadContact(leadId: number, formData: FormData): Promise<ActionResult> {
  const parsed = contactSchema.safeParse({
    name: formData.get("name") ?? "",
    designation: formData.get("designation") ?? "",
    phone: formData.get("phone") ?? "",
    email: formData.get("email") ?? "",
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the contact details." };

  let outcome: leadData.ContactResult = "existing";
  const result = await run(async ({ ctx, actor }) => {
    outcome = await leadData.addLeadContact(ctx, actor, leadId, parsed.data);
  });
  return result.ok ? { ok: true, message: CONTACT_RESULT_MESSAGES[outcome] } : result;
}

export async function resolveDuplicate(leadId: number): Promise<ActionResult> {
  return run(({ ctx, actor }) => leadData.resolveDuplicate(ctx, actor, leadId));
}

export async function deleteLead(leadId: number): Promise<ActionResult> {
  return run(({ ctx, actor }) => leadData.deleteLead(ctx, actor, leadId));
}

/** Attaches a visiting card photo (plus its compressed preview) to a lead the caller can see. */
export async function attachVisitingCard(leadId: number, formData: FormData): Promise<ActionResult> {
  const card = formData.get("card");
  const preview = formData.get("preview");
  if (!(card instanceof File) || card.size === 0) return { ok: false, error: "Choose a photo of the card." };
  if (card.size > MAX_UPLOAD_BYTES) return { ok: false, error: `The photo is larger than ${MAX_UPLOAD_LABEL}.` };
  const bytes = new Uint8Array(await card.arrayBuffer());
  const small = preview instanceof File && preview.size > 0 ? new Uint8Array(await preview.arrayBuffer()) : null;
  const result = await run(({ ctx, actor }) => attachCardToLead(ctx, actor, leadId, bytes, small));
  if (result.ok) revalidatePath(`/leads/${leadId}`);
  return result.ok ? { ok: true, message: "Visiting card attached." } : result;
}

export async function markNotesRead(leadId: number | null): Promise<void> {
  await run(({ ctx, actor }) => leadData.markLeadNotesRead(ctx, actor, leadId));
}
