import "server-only";

import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import { normalizeCompanyName } from "@/lib/company-name";

import { leads, profiles } from "../db/schema";
import type { Actor } from "./actor";
import type { DataContext } from "./context";

// Duplicate companies. Three rules:
//   * exact: same normalized name as another lead. The new or renamed lead is
//     flagged and labelled with the other owners' names (duplicateState).
//   * similar: a fuzzy match on the normalized name, shown as a warning while
//     typing and on save (findSimilarLeads). Any active user sees the owner's
//     name of a similar company, nothing else about it.
//   * same person: a POC phone number (last 10 digits) or email already on
//     another lead (findContactMatches), shown the same way. Retail clients
//     are people, and the same person is often typed with another spelling.
//
// pg_trgm did the fuzzy part before. Here the FTS5 trigram index finds
// candidates and the score below (the same trigram rules as pg_trgm) ranks them.

export const SIMILARITY_THRESHOLD = 0.45;
export const WORD_SIMILARITY_THRESHOLD = 0.6;
const CANDIDATE_LIMIT = 200;

/** pg_trgm's trigrams: each word padded with two spaces before and one after. */
export function trigrams(text: string): Set<string> {
  const set = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) set.add(padded.slice(i, i + 3));
  }
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return common / (a.size + b.size - common);
}

/** Share of trigrams two names have in common (pg_trgm similarity()). */
export function similarity(a: string, b: string): number {
  return jaccard(trigrams(a), trigrams(b));
}

/** Best similarity between `needle` and any run of whole words in `haystack`. */
export function wordSimilarity(needle: string, haystack: string): number {
  const target = trigrams(needle);
  const words = haystack.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let best = 0;
  for (let i = 0; i < words.length; i++) {
    for (let j = i; j < words.length; j++) {
      best = Math.max(best, jaccard(target, trigrams(words.slice(i, j + 1).join(" "))));
    }
  }
  return best;
}

/** How alike two normalized names are, 0 to 1 (the best of the three pg_trgm measures). */
export function nameScore(query: string, candidate: string): number {
  return Math.max(similarity(candidate, query), wordSimilarity(query, candidate), wordSimilarity(candidate, query));
}

export function isSimilar(query: string, candidate: string): boolean {
  return (
    candidate === query ||
    similarity(candidate, query) >= SIMILARITY_THRESHOLD ||
    wordSimilarity(query, candidate) >= WORD_SIMILARITY_THRESHOLD ||
    wordSimilarity(candidate, query) >= WORD_SIMILARITY_THRESHOLD
  );
}

/** An FTS5 query matching any 3-character piece of the name. */
function trigramMatchQuery(normalized: string): string | null {
  const pieces = new Set<string>();
  for (let i = 0; i + 3 <= normalized.length; i++) pieces.add(normalized.slice(i, i + 3));
  if (pieces.size === 0) return null;
  return [...pieces].map((p) => `"${p.replace(/"/g, '""')}"`).join(" OR ");
}

export type SimilarLead = {
  lead_id: number;
  client_name: string;
  assigned_agent_id: string | null;
  assigned_agent_name: string;
  /** The lead's product: one company can hold several leads, one per product. */
  policy_product: string;
  similarity: number;
  is_exact: boolean;
  /** What matched: the company name, or a POC's phone number or email (the same person under another name). */
  matched_on: "name" | "phone" | "email";
};

/** The last 10 digits of a phone number, or null when it is too short or obviously a dummy (0000000000, 1234567890). */
export function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "").slice(-10);
  if (digits.length < 10) return null;
  if (/^(\d)\1+$/.test(digits) || digits === "1234567890" || digits === "0123456789" || digits === "9876543210") return null;
  return digits;
}

/** A lower-cased email worth matching on, or null. */
export function emailKey(email: string | null | undefined): string | null {
  const value = (email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  if (/^(test|na|none|noemail|no-reply|noreply|abc|xyz)@/.test(value)) return null;
  return value;
}

const phoneDigits = (column: AnySQLiteColumn) =>
  sql`substr(replace(replace(replace(replace(replace(replace(${column}, ' ', ''), '-', ''), '+', ''), '(', ''), ')', ''), '.', ''), -10)`;

/**
 * Leads where a POC already has one of these phone numbers (last 10 digits)
 * or emails: for retail clients the person matters more than the spelling of
 * their name. Like name matches, only the owner's name is shown to agents.
 */
export async function findContactMatches(
  ctx: DataContext,
  contacts: { phones?: (string | null | undefined)[]; emails?: (string | null | undefined)[]; excludeId?: number | null },
  limit = 5,
): Promise<SimilarLead[]> {
  const phones = [...new Set((contacts.phones ?? []).map(phoneKey).filter((p): p is string => p !== null))].slice(0, 4);
  const emails = [...new Set((contacts.emails ?? []).map(emailKey).filter((e): e is string => e !== null))].slice(0, 4);
  if (phones.length === 0 && emails.length === 0) return [];
  const conditions = [
    ...(phones.length ? [inArray(phoneDigits(leads.poc_contact_number), phones), inArray(phoneDigits(leads.poc2_contact_number), phones)] : []),
    ...(emails.length ? [inArray(leads.poc_email_id, emails), inArray(leads.poc2_email_id, emails)] : []),
  ];
  const rows = await ctx.db
    .select({
      lead_id: leads.id,
      client_name: leads.client_name,
      assigned_agent_id: leads.assigned_agent_id,
      assigned_agent_name: profiles.full_name,
      policy_product: leads.policy_product,
      phone1: leads.poc_contact_number,
      phone2: leads.poc2_contact_number,
    })
    .from(leads)
    .leftJoin(profiles, eq(profiles.id, leads.assigned_agent_id))
    .where(and(or(...conditions), ne(leads.id, contacts.excludeId ?? -1)))
    .orderBy(asc(leads.id))
    .limit(Math.min(Math.max(limit, 1), 50));
  return rows.map((r) => ({
    lead_id: r.lead_id,
    client_name: r.client_name,
    assigned_agent_id: r.assigned_agent_id,
    assigned_agent_name: r.assigned_agent_name ?? "Unassigned",
    policy_product: r.policy_product,
    similarity: 1,
    is_exact: false,
    matched_on: [r.phone1, r.phone2].some((p) => {
      const key = phoneKey(p);
      return key !== null && phones.includes(key);
    })
      ? "phone"
      : "email",
  }));
}

/** Companies with a similar name, exact matches first. */
export async function findSimilarLeads(
  ctx: DataContext,
  actor: Actor,
  clientName: string,
  options: {
    excludeId?: number | null;
    limit?: number;
    /** POC phone numbers and emails of the lead being saved: also match leads that already have them. */
    phones?: (string | null | undefined)[];
    emails?: (string | null | undefined)[];
  } = {},
): Promise<SimilarLead[]> {
  const limit = Math.min(Math.max(options.limit ?? 5, 1), 50);
  const [byName, byContact] = await Promise.all([
    findSimilarNames(ctx, actor, clientName, { excludeId: options.excludeId, limit }),
    findContactMatches(ctx, { phones: options.phones, emails: options.emails, excludeId: options.excludeId }, limit),
  ]);
  const seen = new Set(byName.map((m) => m.lead_id));
  return [...byName, ...byContact.filter((m) => !seen.has(m.lead_id))].slice(0, limit + byContact.length);
}

async function findSimilarNames(
  ctx: DataContext,
  actor: Actor,
  clientName: string,
  options: { excludeId?: number | null; limit: number },
): Promise<SimilarLead[]> {
  void actor;
  const query = normalizeCompanyName(clientName);
  if (!query) return [];
  const limit = options.limit;
  const excludeId = options.excludeId ?? -1;

  const match = trigramMatchQuery(query);
  // The fuzzy and exact lookups are independent: run them side by side.
  const [fuzzy, exact] = await Promise.all([
    match
      ? ctx.db.all<{ id: number }>(
          sql`select rowid as id from leads_name_fts where leads_name_fts match ${match} order by rank limit ${CANDIDATE_LIMIT}`,
        )
      : [],
    ctx.db.select({ id: leads.id }).from(leads).where(eq(leads.client_name_normalized, query)),
  ]);
  const candidateIds = new Set<number>();
  fuzzy.forEach((r) => candidateIds.add(r.id));
  exact.forEach((r) => candidateIds.add(r.id));
  candidateIds.delete(excludeId);
  if (candidateIds.size === 0) return [];

  // D1 allows at most 100 bound parameters per statement. The FTS search
  // can return 200 candidates (plus exact matches), so query IDs in safe chunks.
  const ids = [...candidateIds];
  const chunks: number[][] = [];
  for (let start = 0; start < ids.length; start += 100) chunks.push(ids.slice(start, start + 100));
  const rows = (
    await Promise.all(
      chunks.map((chunk) =>
        ctx.db
          .select({
            lead_id: leads.id,
            client_name: leads.client_name,
            normalized: leads.client_name_normalized,
            assigned_agent_id: leads.assigned_agent_id,
            assigned_agent_name: profiles.full_name,
            policy_product: leads.policy_product,
          })
          .from(leads)
          .leftJoin(profiles, eq(profiles.id, leads.assigned_agent_id))
          .where(inArray(leads.id, chunk)),
      ),
    )
  ).flat();

  return rows
    .filter((r) => isSimilar(query, r.normalized))
    .map((r) => ({
      lead_id: r.lead_id,
      client_name: r.client_name,
      assigned_agent_id: r.assigned_agent_id,
      assigned_agent_name: r.assigned_agent_name ?? "Unassigned",
      policy_product: r.policy_product,
      similarity: r.normalized === query ? 1 : nameScore(query, r.normalized),
      is_exact: r.normalized === query,
      matched_on: "name" as const,
    }))
    .sort((a, b) => Number(b.is_exact) - Number(a.is_exact) || b.similarity - a.similarity || a.lead_id - b.lead_id)
    .slice(0, limit);
}

/** Exact-name duplicate flag and label for a lead with this name. */
export async function duplicateState(
  ctx: DataContext,
  clientName: string,
  excludeId: number | null = null,
): Promise<{ is_duplicate: boolean; duplicate_label: string }> {
  const rows = await ctx.db
    .selectDistinct({ name: profiles.full_name })
    .from(leads)
    .leftJoin(profiles, eq(profiles.id, leads.assigned_agent_id))
    .where(and(eq(leads.client_name_normalized, normalizeCompanyName(clientName)), ne(leads.id, excludeId ?? -1)));
  if (rows.length === 0) return { is_duplicate: false, duplicate_label: "" };
  const names = [...new Set(rows.map((r) => r.name ?? "Unassigned"))].sort();
  return { is_duplicate: true, duplicate_label: `Duplicate: Already being processed by agent(s) [${names.join(", ")}]` };
}
