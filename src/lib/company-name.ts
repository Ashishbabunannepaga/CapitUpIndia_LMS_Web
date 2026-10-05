// Mirrors public.normalize_company_name() in the core schema migration, so
// the bulk importer can group rows the same way the database flags
// duplicates. Keep the two in sync.

const LEGAL_SUFFIXES = /\b(pvt|private|ltd|limited|llp|llc|inc|incorporated|corp|corporation|plc)\b/g;

export function normalizeCompanyName(name: string | null | undefined): string {
  const raw = (name ?? "").toLowerCase();
  const normalized = raw
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || raw.trim();
}
