import "server-only";

import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { normalizeCompanyName } from "@/lib/company-name";

import { leads, profiles } from "../db/schema";
import type { Actor } from "./actor";
import type { DataContext } from "./context";

// Duplicate companies. Two rules, as before:
//   * exact: same normalized name as another lead. The new or renamed lead is
//     flagged and labelled with the other owners' names (duplicateState).
//   * similar: a fuzzy match on the normalized name, shown as a warning while
//     typing and on save (findSimilarLeads). Any active user sees the owner's
//     name of a similar company, nothing else about it.
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
  similarity: number;
  is_exact: boolean;
};

/** Companies with a similar name, exact matches first. */
export async function findSimilarLeads(
  ctx: DataContext,
  actor: Actor,
  clientName: string,
  options: { excludeId?: number | null; limit?: number } = {},
): Promise<SimilarLead[]> {
  void actor;
  const query = normalizeCompanyName(clientName);
  if (!query) return [];
  const limit = Math.min(Math.max(options.limit ?? 5, 1), 50);
  const excludeId = options.excludeId ?? -1;

  const match = trigramMatchQuery(query);
  const candidateIds = new Set<number>();
  if (match) {
    const rows = await ctx.db.all<{ id: number }>(
      sql`select rowid as id from leads_name_fts where leads_name_fts match ${match} order by rank limit ${CANDIDATE_LIMIT}`,
    );
    rows.forEach((r) => candidateIds.add(r.id));
  }
  const exact = await ctx.db
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.client_name_normalized, query));
  exact.forEach((r) => candidateIds.add(r.id));
  candidateIds.delete(excludeId);
  if (candidateIds.size === 0) return [];

  const rows = await ctx.db
    .select({
      lead_id: leads.id,
      client_name: leads.client_name,
      normalized: leads.client_name_normalized,
      assigned_agent_id: leads.assigned_agent_id,
      assigned_agent_name: profiles.full_name,
    })
    .from(leads)
    .leftJoin(profiles, eq(profiles.id, leads.assigned_agent_id))
    .where(inArray(leads.id, [...candidateIds]));

  return rows
    .filter((r) => isSimilar(query, r.normalized))
    .map((r) => ({
      lead_id: r.lead_id,
      client_name: r.client_name,
      assigned_agent_id: r.assigned_agent_id,
      assigned_agent_name: r.assigned_agent_name ?? "Unassigned",
      similarity: r.normalized === query ? 1 : nameScore(query, r.normalized),
      is_exact: r.normalized === query,
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
