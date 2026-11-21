import { normalizeCompanyName } from "@/lib/company-name";
import { daysBetween, formatDate, isIsoDate } from "@/lib/dates";
import { POLICY_PRODUCTS, UNSPECIFIED_PRODUCT, isOneTimeProduct } from "@/lib/domain";

// Checks an uploaded policy against the lead and what the agent entered.
// AI only reads the document (src/lib/ai); every decision here is a plain
// rule, so the same policy always gives the same result. A "differs" check
// must be acknowledged before the lead becomes Closed Won; "missing" means
// the document did not show it and is only a hint.

/** What the AI read from the policy, cleaned: "" or null where it showed nothing. */
export type PolicyReading = {
  insured_name: string;
  insurer: string;
  policy_number: string;
  policy_product: string;
  plan_name: string;
  policy_start_date: string;
  policy_end_date: string;
  premium: number | null;
  sum_insured: number | null;
};

/** The policy's details as the agent states them (typed in, or picked from the reading). */
export type PolicyValues = {
  policy_start_date: string;
  policy_end_date: string;
  premium: number | null;
  sum_insured: number | null;
  insurer: string;
  policy_number: string;
};

export type CheckResult = "match" | "differs" | "missing";

export type PolicyCheck = {
  field: "insured_name" | "product" | "policy_start_date" | "policy_end_date" | "premium" | "policy_number" | "term" | "renewal_gap";
  label: string;
  /** What the lead or the agent says. */
  expected: string;
  /** What the policy says. */
  found: string;
  result: CheckResult;
  note?: string;
};

export type LeadForCheck = {
  client_name: string;
  policy_product: string;
  /** The renewal date before this policy (the old policy's expiry), if any. */
  renewal_date: string | null;
};

/** How far a renewal's new start may be from the old expiry date. */
export const RENEWAL_GAP_DAYS = 30;

function money(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const digits = value.replace(/[,\s₹]|rs\.?|inr/gi, "");
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Cleans the model's JSON into a reading; anything malformed becomes empty. */
export function cleanPolicyReading(raw: Record<string, unknown>): PolicyReading {
  const date = (v: unknown) => (isIsoDate(v) ? v : "");
  const product = str(raw.policy_product, 40);
  return {
    insured_name: str(raw.insured_name, 300),
    insurer: str(raw.insurer, 200),
    policy_number: str(raw.policy_number, 100),
    policy_product: (POLICY_PRODUCTS as readonly string[]).includes(product) && product !== UNSPECIFIED_PRODUCT ? product : "",
    plan_name: str(raw.plan_name, 200),
    policy_start_date: date(raw.policy_start_date),
    policy_end_date: date(raw.policy_end_date),
    premium: money(raw.premium),
    sum_insured: money(raw.sum_insured),
  };
}

/** Whether two names are the same insured: equal, one inside the other, or most words shared. */
export function sameInsured(a: string, b: string): boolean {
  const x = normalizeCompanyName(a);
  const y = normalizeCompanyName(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const wa = new Set(x.split(" ").filter((w) => w.length > 1));
  const wb = new Set(y.split(" ").filter((w) => w.length > 1));
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared > 0 && shared / Math.min(wa.size, wb.size) >= 0.6;
}

const inr = (n: number | null) => (n === null ? "" : `₹${n.toLocaleString("en-IN")}`);
const dateText = (d: string) => (d ? formatDate(d) : "");
const policyNo = (s: string) => s.replace(/[\s\-/]/g, "").toUpperCase();

function compare(expected: string, found: string, same: boolean): CheckResult {
  if (!found) return "missing";
  if (!expected) return "match";
  return same ? "match" : "differs";
}

/**
 * Every check of a policy. `reading` is null when the document could not be
 * read (AI unavailable): then only the checks on the values themselves run.
 */
export function checkPolicy(reading: PolicyReading | null, values: PolicyValues, lead: LeadForCheck): PolicyCheck[] {
  const checks: PolicyCheck[] = [];
  const oneTime = isOneTimeProduct(lead.policy_product);
  if (reading) {
    checks.push({
      field: "insured_name",
      label: "Insured name",
      expected: lead.client_name,
      found: reading.insured_name,
      result: compare(lead.client_name, reading.insured_name, sameInsured(lead.client_name, reading.insured_name)),
    });
    const leadProduct = lead.policy_product === UNSPECIFIED_PRODUCT ? "" : lead.policy_product;
    checks.push({
      field: "product",
      label: "Product",
      expected: leadProduct,
      found: reading.policy_product,
      result: compare(leadProduct, reading.policy_product, leadProduct === reading.policy_product),
    });
    checks.push({
      field: "policy_start_date",
      label: "Policy start",
      expected: dateText(values.policy_start_date),
      found: dateText(reading.policy_start_date),
      result: compare(values.policy_start_date, reading.policy_start_date, values.policy_start_date === reading.policy_start_date),
    });
    checks.push({
      field: "policy_end_date",
      label: "Policy end",
      expected: dateText(values.policy_end_date),
      found: dateText(reading.policy_end_date),
      result: compare(values.policy_end_date, reading.policy_end_date, values.policy_end_date === reading.policy_end_date),
    });
    checks.push({
      field: "premium",
      label: "Premium",
      expected: inr(values.premium),
      found: inr(reading.premium),
      result:
        reading.premium === null
          ? "missing"
          : values.premium === null
            ? "match"
            : Math.abs(values.premium - reading.premium) <= Math.max(1, reading.premium * 0.01)
              ? "match"
              : "differs",
    });
    checks.push({
      field: "policy_number",
      label: "Policy number",
      expected: values.policy_number,
      found: reading.policy_number,
      result: compare(values.policy_number, reading.policy_number, policyNo(values.policy_number) === policyNo(reading.policy_number)),
    });
  }

  // Rules on the values themselves.
  const { policy_start_date: start, policy_end_date: end } = values;
  if (start && end) {
    const days = daysBetween(start, end);
    const yearly = days >= 300 && days <= 400;
    checks.push({
      field: "term",
      label: "Policy period",
      expected: oneTime ? "Ends after it starts" : "About one year",
      found: `${days} days`,
      result: days > 0 && (oneTime || yearly) ? "match" : "differs",
      note: days <= 0 ? "The end date is not after the start date." : !oneTime && !yearly ? "Not a one-year policy: check both dates." : undefined,
    });
  }
  if (start && lead.renewal_date && !oneTime) {
    const gap = Math.abs(daysBetween(lead.renewal_date, start));
    checks.push({
      field: "renewal_gap",
      label: "Follows the last policy",
      expected: `Starts near ${formatDate(lead.renewal_date)}`,
      found: dateText(start),
      result: gap <= RENEWAL_GAP_DAYS ? "match" : "differs",
      note: gap > RENEWAL_GAP_DAYS ? `Starts ${gap} days from the lead's renewal date.` : undefined,
    });
  }
  return checks;
}

export function hasDifferences(checks: PolicyCheck[]): boolean {
  return checks.some((c) => c.result === "differs");
}
