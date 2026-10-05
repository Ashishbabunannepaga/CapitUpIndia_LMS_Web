"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { PostgrestError } from "@supabase/supabase-js";

import { isAdmin, requireAdmin, requireProfile } from "@/lib/auth";
import type { BusinessType, LeadStatus, LeadType, PolicyProduct } from "@/lib/database.types";
import { isLeadStatus } from "@/lib/domain";
import { findSimilarLeads } from "@/lib/leads";
import { contactSchema, formDataToObject, leadFormSchema, type LeadFormValues } from "@/lib/lead-schema";
import { createClient } from "@/lib/supabase/server";

export type SimilarLead = Awaited<ReturnType<typeof findSimilarLeads>>[number];

export type LeadFormState = {
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
  /** Similar companies found on save; the user must confirm to continue. */
  duplicates?: SimilarLead[];
  values?: Record<string, string>;
};

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

function friendlyError(error: PostgrestError | null | undefined): string {
  if (!error) return "Something went wrong. Try again.";
  if (error.code === "42501") return "You don't have access to change this lead.";
  if (error.code === "23514") return "Some details are not in a valid format.";
  if (error.code === "PGRST116" || error.code === "P0002") return "That lead no longer exists or isn't yours.";
  return error.message || "Something went wrong. Try again.";
}

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
  await requireProfile();
  const name = clientName.trim().slice(0, 300);
  if (name.length < 3) return [];
  return findSimilarLeads(name, excludeId);
}

export async function createLead(_prev: LeadFormState, formData: FormData): Promise<LeadFormState> {
  const profile = await requireProfile();
  const parsed = parseLeadForm(formData);
  if (!parsed.ok) return parsed.state;
  const { values, raw } = parsed;

  // Never create a competing company record without an explicit decision.
  const similar = await findSimilarLeads(values.client_name);
  if (similar.length > 0 && !values.confirm_duplicate) {
    return { duplicates: similar, values: raw };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("leads")
    .insert({
      ...toRow(values),
      // Agents always own what they create; admins choose (or leave unassigned).
      assigned_agent_id: isAdmin(profile) ? values.assigned_agent_id : profile.id,
    })
    .select("id")
    .single();
  if (error) return { error: friendlyError(error), values: raw };

  refreshWorkspace();
  redirect(`/leads/${data.id}?saved=created`);
}

export async function updateLead(leadId: number, _prev: LeadFormState, formData: FormData): Promise<LeadFormState> {
  const profile = await requireProfile();
  const parsed = parseLeadForm(formData);
  if (!parsed.ok) return parsed.state;
  const { values, raw } = parsed;

  const supabase = await createClient();
  const { data: current, error: readError } = await supabase
    .from("leads")
    .select("client_name")
    .eq("id", leadId)
    .maybeSingle();
  if (readError) return { error: friendlyError(readError), values: raw };
  if (!current) return { error: "That lead no longer exists or isn't yours.", values: raw };

  if (current.client_name.trim().toLowerCase() !== values.client_name.toLowerCase()) {
    const similar = await findSimilarLeads(values.client_name, leadId);
    if (similar.length > 0 && !values.confirm_duplicate) {
      return { duplicates: similar, values: raw };
    }
  }

  const { error } = await supabase
    .from("leads")
    .update({
      ...toRow(values),
      ...(isAdmin(profile) ? { assigned_agent_id: values.assigned_agent_id } : {}),
    })
    .eq("id", leadId)
    .select("id")
    .single();
  if (error) return { error: friendlyError(error), values: raw };

  refreshWorkspace();
  redirect(`/leads/${leadId}?saved=updated`);
}

/**
 * Instead of creating a competing record, add the form's contacts (and note)
 * to a lead the user can already see, using the POC merge rule. The target
 * lead comes from the clicked button (name="merge_into").
 */
export async function mergeIntoExistingLead(_prev: LeadFormState, formData: FormData): Promise<LeadFormState> {
  await requireProfile();
  const parsed = parseLeadForm(formData);
  if (!parsed.ok) return parsed.state;
  const { values, raw } = parsed;
  const targetLeadId = Number(formData.get("merge_into"));
  if (!Number.isInteger(targetLeadId) || targetLeadId <= 0) return { error: "Pick a lead to add to.", values: raw };
  const supabase = await createClient();

  const contacts = [
    [values.poc_name, values.poc_designation, values.poc_contact_number, values.poc_email_id],
    [values.poc2_name, values.poc2_designation, values.poc2_contact_number, values.poc2_email_id],
  ].filter(([name, , phone, email]) => name || phone || email);

  for (const [name, designation, phone, email] of contacts) {
    const { error } = await supabase.rpc("add_lead_contact", {
      p_lead_id: targetLeadId,
      p_name: name,
      p_designation: designation,
      p_phone: phone,
      p_email: email,
    });
    if (error) return { error: friendlyError(error), values: raw };
  }
  if (values.notes) {
    const { error } = await supabase.from("lead_notes").insert({ lead_id: targetLeadId, content: values.notes });
    if (error) return { error: friendlyError(error), values: raw };
  }

  refreshWorkspace();
  redirect(`/leads/${targetLeadId}?saved=merged`);
}

export async function setLeadStatus(leadId: number, status: string): Promise<ActionResult> {
  await requireProfile();
  if (!isLeadStatus(status)) return { ok: false, error: "Unknown status." };
  const supabase = await createClient();
  const { error } = await supabase.from("leads").update({ status }).eq("id", leadId).select("id").single();
  if (error) return { ok: false, error: friendlyError(error) };
  refreshWorkspace();
  return { ok: true };
}

export async function assignLead(leadId: number, agentId: string | null): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  if (agentId) {
    const { data: agent } = await supabase.from("profiles").select("id, is_active").eq("id", agentId).maybeSingle();
    if (!agent?.is_active) return { ok: false, error: "Pick an active team member." };
  }
  const { error } = await supabase
    .from("leads")
    .update({ assigned_agent_id: agentId })
    .eq("id", leadId)
    .select("id")
    .single();
  if (error) return { ok: false, error: friendlyError(error) };
  refreshWorkspace();
  return { ok: true };
}

export async function addLeadNote(leadId: number, content: string): Promise<ActionResult> {
  await requireProfile();
  const text = content.trim();
  if (!text) return { ok: false, error: "Write a note first." };
  if (text.length > 5000) return { ok: false, error: "Keep notes under 5000 characters." };
  const supabase = await createClient();
  const { error } = await supabase.from("lead_notes").insert({ lead_id: leadId, content: text });
  if (error) return { ok: false, error: friendlyError(error) };
  refreshWorkspace();
  return { ok: true };
}

const CONTACT_RESULT_MESSAGES = {
  poc1: "Added as the primary POC.",
  poc2: "Added as the secondary POC.",
  notes: "Both POC slots are taken, so the contact was added to the lead's notes.",
  existing: "This contact is already on the lead.",
} as const;

export async function addLeadContact(leadId: number, formData: FormData): Promise<ActionResult> {
  await requireProfile();
  const parsed = contactSchema.safeParse({
    name: formData.get("name") ?? "",
    designation: formData.get("designation") ?? "",
    phone: formData.get("phone") ?? "",
    email: formData.get("email") ?? "",
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the contact details." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("add_lead_contact", {
    p_lead_id: leadId,
    p_name: parsed.data.name,
    p_designation: parsed.data.designation,
    p_phone: parsed.data.phone,
    p_email: parsed.data.email,
  });
  if (error) return { ok: false, error: friendlyError(error) };
  refreshWorkspace();
  return { ok: true, message: CONTACT_RESULT_MESSAGES[data] ?? "Contact saved." };
}

export async function resolveDuplicate(leadId: number): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase
    .from("leads")
    .update({ is_duplicate: false })
    .eq("id", leadId)
    .select("id")
    .single();
  if (error) return { ok: false, error: friendlyError(error) };
  refreshWorkspace();
  return { ok: true };
}

export async function deleteLead(leadId: number): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase.from("leads").delete().eq("id", leadId).select("id").single();
  if (error) return { ok: false, error: friendlyError(error) };
  refreshWorkspace();
  return { ok: true };
}

export async function markNotesRead(leadId: number | null): Promise<void> {
  await requireProfile();
  const supabase = await createClient();
  await supabase.rpc("mark_lead_notes_read", { p_lead_id: leadId });
  refreshWorkspace();
}
