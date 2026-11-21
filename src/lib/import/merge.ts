import { UNSPECIFIED_PRODUCT } from "@/lib/domain";

// Which existing lead an imported row may be merged into. A lead is one
// company AND one product, so "Acme / Fire" must never be folded into
// "Acme / Health": the Fire opportunity and its renewal date would be lost.

export type ExistingLead = { id: number; policy_product: string };

export type MergeDecision =
  /** Fill gaps on this lead (same product, or one side's product is unknown). */
  | { action: "merge"; leadId: number; setProduct: boolean }
  /** The company exists with other products only: add this product as its own lead. */
  | { action: "new_product"; existingProducts: string[] }
  /** The company is not in the CRM yet. */
  | { action: "create" };

export function pickMergeTarget(existing: readonly ExistingLead[], product: string): MergeDecision {
  if (existing.length === 0) return { action: "create" };
  const sorted = [...existing].sort((a, b) => a.id - b.id);
  const same = sorted.find((lead) => lead.policy_product === product);
  if (same) return { action: "merge", leadId: same.id, setProduct: false };
  // The row does not say which product: it can only add contacts and notes.
  if (product === UNSPECIFIED_PRODUCT) return { action: "merge", leadId: sorted[0].id, setProduct: false };
  // A lead whose product was never filled in takes this one.
  const open = sorted.find((lead) => lead.policy_product === UNSPECIFIED_PRODUCT);
  if (open) return { action: "merge", leadId: open.id, setProduct: true };
  return { action: "new_product", existingProducts: [...new Set(sorted.map((lead) => lead.policy_product))] };
}

/** One import group per company and product. */
export function importGroupKey(normalizedCompany: string, product: string): string {
  return `${normalizedCompany}\u0000${product}`;
}
