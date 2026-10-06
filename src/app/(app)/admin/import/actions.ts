"use server";

import { revalidatePath } from "next/cache";
import { readSheet } from "read-excel-file/node";
import { z } from "zod";

import { AiRateLimitError, AiUnavailableError, generate, MODELS, parseJsonObject } from "@/lib/ai/gemini";
import { cleanExtractedLead, type ExtractedLead } from "@/lib/ai/lead-cleanup";
import { bulkMappingPrompt } from "@/lib/ai/prompts";
import { bulkLeadsSchema } from "@/lib/ai/schemas";
import { requireAdmin } from "@/lib/auth";
import { normalizeCompanyName } from "@/lib/company-name";
import type { LeadStatus } from "@/lib/database.types";
import { todayInBusinessTz } from "@/lib/dates";
import { isLeadStatus } from "@/lib/domain";
import { fromCellMatrix, parsePastedSheet, rowsAsText, heuristicMapRow, type ParsedSheet } from "@/lib/import/sheet";
import { createClient } from "@/lib/supabase/server";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/upload-limits";

// Bulk ingestion for admins: paste TSV/CSV or upload a sheet, let Gemini map
// the columns (15 rows per request, as the existing app did), review every
// row, then commit. Rows are never imported without a preview, existing
// companies are merged through add_lead_contact() instead of overwritten,
// and new leads can be distributed round-robin.

const CHUNK_SIZE = 15;
const MAX_ROWS = 500;
const MAX_PASTE = 500_000;

export type PreviewRow = {
  row: number;
  lead: ExtractedLead;
  /** Problems that stop this row being imported. */
  errors: string[];
  /** Things worth knowing: dropped values, a company already in the CRM. */
  warnings: string[];
  /** The existing lead this row will be merged into (same company name). */
  existing?: { id: number; client_name: string; agent_name: string };
  /** The row as it was in the sheet, so the user can see what was mapped. */
  source: string;
};

export type PreviewResult =
  | {
      ok: true;
      rows: PreviewRow[];
      mappedBy: "ai" | "basic";
      notice?: string;
      /** Rows beyond the import limit, left out of the preview. */
      skipped: number;
    }
  | { ok: false; error: string };

export type CommitResult =
  | { ok: true; created: number; merged: number; failed: number; errors: string[] }
  | { ok: false; error: string };

function toSheet(text: string): ParsedSheet {
  return parsePastedSheet(text);
}

/** Maps one chunk with Gemini; falls back to the heuristic mapper per chunk. */
async function mapChunk(
  user: { id: string; full_name: string },
  sheet: ParsedSheet,
  chunk: ParsedSheet["rows"],
  index: number,
  total: number,
  today: string,
  calls: number,
): Promise<Map<number, Record<string, unknown>>> {
  const { value } = await generate({
    user,
    feature: "bulk_mapping",
    models: MODELS.text,
    systemInstruction: bulkMappingPrompt(today),
    contents: `Spreadsheet rows (chunk ${index + 1} of ${total}):\n${rowsAsText(sheet, chunk)}`,
    temperature: 0.1,
    jsonSchema: bulkLeadsSchema,
    rateLimitCalls: calls,
    parse: (text) => {
      const parsed = parseJsonObject(text);
      const leads = parsed.leads;
      if (!Array.isArray(leads) || leads.length === 0) throw new Error("No leads in response");
      return leads as Record<string, unknown>[];
    },
  });

  const byRow = new Map<number, Record<string, unknown>>();
  value.forEach((lead, i) => {
    const claimed = Number(lead.source_row);
    const row = chunk.some((r) => r.row === claimed) ? claimed : (chunk[i]?.row ?? -1);
    if (row > 0 && !byRow.has(row)) byRow.set(row, lead);
  });
  return byRow;
}

async function buildPreview(sheet: ParsedSheet, useAi: boolean): Promise<PreviewResult> {
  const profile = await requireAdmin();
  const today = todayInBusinessTz();
  if (sheet.rows.length === 0) return { ok: false, error: "No data rows found. Paste rows or upload a sheet." };

  const skipped = Math.max(0, sheet.rows.length - MAX_ROWS);
  const rows = sheet.rows.slice(0, MAX_ROWS);
  const chunks: ParsedSheet["rows"][] = [];
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) chunks.push(rows.slice(i, i + CHUNK_SIZE));

  const mapped = new Map<number, Record<string, unknown>>();
  let mappedBy: "ai" | "basic" = "basic";
  let notice: string | undefined;

  if (useAi) {
    try {
      const results = await Promise.all(
        chunks.map((chunk, i) =>
          mapChunk(profile, sheet, chunk, i, chunks.length, today, i === 0 ? chunks.length : 0).catch((error) => {
            if (error instanceof AiRateLimitError) throw error;
            return null;
          }),
        ),
      );
      const failed = results.filter((r) => r === null).length;
      for (const result of results) {
        if (result) for (const [row, lead] of result) mapped.set(row, lead);
      }
      if (mapped.size > 0) mappedBy = "ai";
      if (failed > 0) {
        notice = `${failed} of ${chunks.length} batches could not be mapped by AI; those rows use basic column matching. Check them closely.`;
      }
    } catch (error) {
      if (error instanceof AiRateLimitError) return { ok: false, error: error.message };
      if (!(error instanceof AiUnavailableError)) throw error;
      notice = `${error.message} Rows were mapped by basic column matching instead, so check every row.`;
    }
  }

  const supabase = await createClient();
  const preview: PreviewRow[] = [];
  const seen = new Map<string, number>();

  for (const row of rows) {
    const raw = mapped.get(row.row) ?? heuristicMapRow(sheet, row, today);
    const { lead, dropped } = cleanExtractedLead(raw, { today });
    const errors: string[] = [];
    const warnings = [...dropped];
    if (!lead.client_name) errors.push("No company or client name");
    if (!lead.poc_name && !lead.poc_contact_number && !lead.poc_email_id) {
      warnings.push("no contact details in this row");
    }

    const key = normalizeCompanyName(lead.client_name);
    if (key && seen.has(key)) {
      warnings.push(`same company as row ${seen.get(key)} in this sheet; contacts will be merged into one lead`);
    } else if (key) {
      seen.set(key, row.row);
    }

    preview.push({ row: row.row, lead, errors, warnings, source: row.cells.join(" | ") });
  }

  // One lookup per distinct company, so the preview says what already exists.
  // The same company name merges into its lead; a similar name only warns,
  // because "Renee Systems" and "Renee Systems India" may be two companies.
  const names = [...new Set(preview.filter((p) => p.lead.client_name).map((p) => p.lead.client_name))];
  const matches = await Promise.all(
    names.map(async (name) => {
      const { data } = await supabase.rpc("find_similar_leads", { p_client_name: name, p_limit: 3 });
      return [normalizeCompanyName(name), data ?? []] as const;
    }),
  );
  const matchesByKey = new Map(matches);

  for (const item of preview) {
    const found = matchesByKey.get(normalizeCompanyName(item.lead.client_name)) ?? [];
    const exact = found.find((m) => m.is_exact);
    if (exact) {
      item.existing = { id: exact.lead_id, client_name: exact.client_name, agent_name: exact.assigned_agent_name };
      item.warnings.push(`already in the CRM as "${exact.client_name}" (${exact.assigned_agent_name})`);
    }
    for (const similar of found.filter((m) => !m.is_exact).slice(0, 2)) {
      item.warnings.push(
        `similar to "${similar.client_name}" (${similar.assigned_agent_name}); check before importing as a separate lead`,
      );
    }
  }

  return { ok: true, rows: preview, mappedBy, notice, skipped };
}

export async function previewPastedRows(text: string, useAi: boolean): Promise<PreviewResult> {
  await requireAdmin();
  const content = String(text ?? "");
  if (!content.trim()) return { ok: false, error: "Paste some rows first." };
  if (content.length > MAX_PASTE) return { ok: false, error: "That paste is too large. Import it in smaller batches." };
  return buildPreview(toSheet(content), useAi);
}

export async function previewUploadedSheet(formData: FormData): Promise<PreviewResult> {
  await requireAdmin();
  const file = formData.get("sheet");
  const useAi = formData.get("use_ai") !== "false";
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a file to import." };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: `That file is larger than ${MAX_UPLOAD_LABEL}.` };

  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx")) {
    try {
      const matrix = await readSheet(Buffer.from(await file.arrayBuffer()));
      return buildPreview(fromCellMatrix(matrix), useAi);
    } catch {
      return { ok: false, error: "That spreadsheet could not be read. Save it as .xlsx or paste the rows instead." };
    }
  }
  if (name.endsWith(".csv") || name.endsWith(".txt") || name.endsWith(".tsv")) {
    return buildPreview(toSheet(await file.text()), useAi);
  }
  return { ok: false, error: "Upload an .xlsx, .csv or .tsv file, or paste the rows." };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

const commitSchema = z.object({
  status: z.string().refine(isLeadStatus, "Pick a valid status."),
  allocation: z.enum(["round_robin", "agent", "unassigned"]),
  agentId: z.string().trim(),
  rows: z
    .array(
      z.object({
        client_name: z.string().trim().min(1).max(300),
        type: z.enum(["New", "Renewal"]),
        business_type: z.enum(["Corporate", "Retail"]),
        policy_product: z.string(),
        sub_product_name: z.string().max(200),
        renewal_date: z.string(),
        address: z.string().max(1000),
        poc_name: z.string().max(120),
        poc_designation: z.string().max(120),
        poc_contact_number: z.string().max(32),
        poc_email_id: z.string().max(200),
        poc2_name: z.string().max(120),
        poc2_designation: z.string().max(120),
        poc2_contact_number: z.string().max(32),
        poc2_email_id: z.string().max(200),
        notes: z.string().max(20000),
      }),
    )
    .min(1, "Nothing to import.")
    .max(MAX_ROWS),
});

export type CommitInput = z.input<typeof commitSchema>;

/**
 * Creates or merges the reviewed rows.
 *   * A company already in the CRM keeps its lead: the row's contacts go
 *     through add_lead_contact() (POC 1, then POC 2, then notes), the
 *     renewal date and sub-product fill in only if missing, and an import
 *     note records what happened. Nothing is overwritten.
 *   * Everything else is created with the chosen status and owner.
 * Runs as the admin, so RLS still applies.
 */
export async function commitImport(input: CommitInput): Promise<CommitResult> {
  const profile = await requireAdmin();
  const parsed = commitSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the rows before importing." };
  const { status, allocation, agentId, rows } = parsed.data;
  const supabase = await createClient();
  const today = todayInBusinessTz();

  if (allocation === "agent") {
    const { data: agent } = await supabase.from("profiles").select("id, is_active").eq("id", agentId).maybeSingle();
    if (!agent?.is_active) return { ok: false, error: "Pick an active agent to assign these leads to." };
  }

  // Merge rows for the same company so one company becomes one lead.
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = normalizeCompanyName(row.client_name);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  // Which companies already exist (checked again here, not trusted from the preview).
  const existing = new Map<string, number>();
  await Promise.all(
    [...groups.values()].map(async ([first]) => {
      const { data } = await supabase.rpc("find_similar_leads", {
        p_client_name: first.client_name,
        p_limit: 1,
        p_threshold: 0.8,
      });
      const exact = data?.find((m) => m.is_exact);
      if (exact) existing.set(normalizeCompanyName(first.client_name), exact.lead_id);
    }),
  );

  const newGroups = [...groups.entries()].filter(([key]) => !existing.has(key));
  let owners: (string | null)[] = newGroups.map(() => (allocation === "agent" ? agentId : null));
  if (allocation === "round_robin" && newGroups.length > 0) {
    const { data, error } = await supabase.rpc("next_round_robin_agents", { p_count: newGroups.length });
    if (error) return { ok: false, error: "Could not work out the round-robin order. Try again." };
    owners = data?.length ? data : newGroups.map(() => null);
  }

  let created = 0;
  let merged = 0;
  let failed = 0;
  const errors: string[] = [];
  const fail = (company: string, message: string) => {
    failed++;
    if (errors.length < 5) errors.push(`${company}: ${message}`);
  };

  let ownerIndex = 0;
  for (const [key, groupRows] of groups) {
    const [first] = groupRows;
    const leadId = existing.get(key);

    if (leadId === undefined) {
      const owner = owners[ownerIndex++] ?? null;
      const { data, error } = await supabase
        .from("leads")
        .insert({
          client_name: first.client_name,
          type: first.type,
          business_type: first.business_type,
          policy_product: first.policy_product as never,
          sub_product_name: first.sub_product_name,
          renewal_date: first.renewal_date || null,
          address: first.address,
          poc_name: first.poc_name,
          poc_designation: first.poc_designation,
          poc_contact_number: first.poc_contact_number,
          poc_email_id: first.poc_email_id,
          poc2_name: first.poc2_name,
          poc2_designation: first.poc2_designation,
          poc2_contact_number: first.poc2_contact_number,
          poc2_email_id: first.poc2_email_id,
          notes: first.notes,
          status: status as LeadStatus,
          assigned_agent_id: owner,
        })
        .select("id")
        .single();
      if (error || !data) {
        fail(first.client_name, error?.message ?? "could not be created");
        continue;
      }
      created++;
      await addExtraContacts(supabase, data.id, groupRows.slice(1), first);
      continue;
    }

    // Existing company: fill the gaps, never overwrite.
    const { data: current } = await supabase.from("leads").select("*").eq("id", leadId).maybeSingle();
    if (!current) {
      fail(first.client_name, "the existing lead belongs to an agent and is not visible");
      continue;
    }
    const patch: { renewal_date?: string; sub_product_name?: string; address?: string } = {};
    if (!current.renewal_date && first.renewal_date) patch.renewal_date = first.renewal_date;
    if (!current.sub_product_name && first.sub_product_name) patch.sub_product_name = first.sub_product_name;
    if (!current.address && first.address) patch.address = first.address;
    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from("leads").update(patch).eq("id", leadId).select("id").single();
      if (error) fail(first.client_name, error.message);
    }
    const contactResults = await addExtraContacts(supabase, leadId, groupRows, null);
    const importNote = [
      `Bulk import ${today} by ${profile.full_name}.`,
      contactResults.length > 0 ? `Contacts: ${contactResults.join("; ")}.` : "No new contacts in the sheet.",
      groupRows
        .map((r) => r.notes.trim())
        .filter(Boolean)
        .join("\n"),
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 5000);
    const { error: noteError } = await supabase.from("lead_notes").insert({ lead_id: leadId, content: importNote });
    if (noteError) fail(first.client_name, noteError.message);
    else merged++;
  }

  revalidatePath("/", "layout");
  return { ok: true, created, merged, failed, errors };
}

const CONTACT_WORDS: Record<string, string> = {
  poc1: "added as primary POC",
  poc2: "added as secondary POC",
  notes: "added to the lead's notes (both POC slots were taken)",
  existing: "already on the lead",
};

/** Adds every contact in these rows through the POC merge rule. */
async function addExtraContacts(
  supabase: Awaited<ReturnType<typeof createClient>>,
  leadId: number,
  rows: { poc_name: string; poc_designation: string; poc_contact_number: string; poc_email_id: string; poc2_name: string; poc2_designation: string; poc2_contact_number: string; poc2_email_id: string }[],
  skip: { poc_name: string; poc_contact_number: string; poc_email_id: string } | null,
): Promise<string[]> {
  const results: string[] = [];
  for (const row of rows) {
    const contacts = [
      [row.poc_name, row.poc_designation, row.poc_contact_number, row.poc_email_id],
      [row.poc2_name, row.poc2_designation, row.poc2_contact_number, row.poc2_email_id],
    ].filter(([name, , phone, email]) => {
      if (!name && !phone && !email) return false;
      // The first row's primary contact is already on the new lead.
      return !(skip && name === skip.poc_name && phone === skip.poc_contact_number && email === skip.poc_email_id);
    });
    for (const [name, designation, phone, email] of contacts) {
      const { data, error } = await supabase.rpc("add_lead_contact", {
        p_lead_id: leadId,
        p_name: name,
        p_designation: designation,
        p_phone: phone,
        p_email: email,
      });
      if (!error && data) results.push(`${name || phone || email} ${CONTACT_WORDS[data] ?? data}`);
    }
  }
  return results;
}
