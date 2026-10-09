import type { BusinessType, LeadType, PolicyProduct } from "@/lib/database.types";
import { isValidIsoDate, parseLooseDate } from "@/lib/date-parse";
import { DEFAULT_POC_DESIGNATION } from "@/lib/domain";

// Deterministic clean-up applied to everything AI (or a heuristic) extracts
// before a person sees it: the existing app's verifyParsedData rules, minus
// its director -> poc rewrite (explicit designations are kept). AI suggests;
// these rules decide.

export type ExtractedLead = {
  client_name: string;
  type: LeadType;
  business_type: BusinessType;
  policy_product: PolicyProduct;
  sub_product_name: string;
  renewal_date: string;
  address: string;
  poc_name: string;
  poc_designation: string;
  poc_contact_number: string;
  poc_email_id: string;
  poc2_name: string;
  poc2_designation: string;
  poc2_contact_number: string;
  poc2_email_id: string;
  notes: string;
};

export const EXTRACTED_TEXT_FIELDS = [
  "client_name",
  "sub_product_name",
  "renewal_date",
  "address",
  "poc_name",
  "poc_designation",
  "poc_contact_number",
  "poc_email_id",
  "poc2_name",
  "poc2_designation",
  "poc2_contact_number",
  "poc2_email_id",
  "notes",
] as const;

const MAX_LENGTH: Partial<Record<keyof ExtractedLead, number>> = {
  client_name: 300,
  sub_product_name: 200,
  address: 1000,
  poc_name: 120,
  poc_designation: 120,
  poc2_name: 120,
  poc2_designation: 120,
  poc_contact_number: 32,
  poc2_contact_number: 32,
  notes: 20000,
};

const DUMMY_PHONES = new Set(["9999999999", "9876543210", "1234567890", "0123456789", "9898989898"]);
const DUMMY_EMAILS = new Set(["contact@company.com", "rahul@acme.com", "john@acme.com", "john@abccorp.com", "test@test.com"]);
const DUMMY_EMAIL_DOMAINS = /@(example\.(com|org|net)|domain\.com|email\.com|company\.com)$/;

const PRODUCT_KEYWORDS: [RegExp, PolicyProduct][] = [
  [/fire|property|burglary|package|\bsfsp\b|\biar\b|industrial all risk/, "Fire or Property"],
  [/\bwc\b|workm[ae]n|worker|liabilit|\bd&o\b|directors|professional indemnity|\bpi\b|\bcgl\b|cyber/, "Liability"],
  [/marine|cargo|transit|hull/, "Marine"],
  [/\bcredit\b|trade credit/, "Credit"],
  [/travel/, "Travel"],
  [/\blife\b|term plan|\bgtl\b|group term/, "Life"],
  [/motor|vehicle|\bcar\b|4 ?wheeler|2 ?wheeler|two wheeler|four wheeler|bike|fleet|truck/, "Motor"],
  [/health|medical|mediclaim|\bgmc\b|\bgpa\b|floater|hospital/, "Health"],
  // Weak hints last, so "health cover for office staff" stays Health.
  [/\boffice\b|\bshop\b/, "Fire or Property"],
];

/** One of the 8 products; keyword match on free text, Health when nothing fits. */
export function normalizeProduct(value: string | null | undefined): PolicyProduct {
  const text = (value ?? "").toLowerCase();
  if (text === "fire or property") return "Fire or Property";
  for (const [pattern, product] of PRODUCT_KEYWORDS) {
    if (pattern.test(text)) return product;
  }
  return "Health";
}

const RETAIL_HINTS = /\bretail\b|individual|family|personal|self\b|4 ?wheeler|2 ?wheeler|two wheeler|four wheeler|\bcar\b|bike/;

export function normalizeBusinessType(value: string | null | undefined, context = ""): BusinessType {
  const text = `${value ?? ""}`.toLowerCase();
  if (text.includes("retail")) return "Retail";
  if (text.includes("corporate")) return "Corporate";
  return RETAIL_HINTS.test(context.toLowerCase()) ? "Retail" : "Corporate";
}

function str(value: unknown): string {
  if (value == null) return "";
  return String(value).replace(/\s+/g, (s) => (s.includes("\n") ? "\n" : " ")).trim();
}

/** Every phone-like number in a string, as digits. */
function phoneCandidates(text: string): string[] {
  return (text.match(/\+?\d[\d\s\-().]{6,}\d/g) ?? []).map((raw) => raw.replace(/\D/g, ""));
}

/** Indian numbers without the country code / trunk prefix. */
function canonicalPhone(digits: string): string {
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 13 && digits.startsWith("091")) return digits.slice(3);
  return digits;
}

function isDummyPhone(digits: string): boolean {
  return DUMMY_PHONES.has(digits) || /^(\d)\1+$/.test(digits);
}

type CleanOptions = {
  /** The text the user gave. When present, numbers and emails not found in it are dropped as hallucinations. */
  sourceText?: string;
  /** Today in business time (YYYY-MM-DD), for month-only dates. */
  today: string;
};

/** Cleans a phone field: digits only, no dummies, no numbers missing from the source, de-duplicated. */
export function cleanPhones(value: string, opts: { sourceText?: string }, dropped: string[] = []): string {
  const source = opts.sourceText !== undefined ? new Set(phoneCandidates(opts.sourceText).map(canonicalPhone)) : null;
  const sourceDigits = opts.sourceText?.replace(/\D/g, "") ?? "";
  const out: string[] = [];
  for (const raw of phoneCandidates(value)) {
    const digits = canonicalPhone(raw);
    if (digits.length < 8 || digits.length > 13) continue;
    if (isDummyPhone(digits)) {
      dropped.push(`placeholder number ${digits}`);
      continue;
    }
    if (source && !source.has(digits) && !sourceDigits.includes(digits)) {
      dropped.push(`number ${digits} (not in your text)`);
      continue;
    }
    if (!out.includes(digits)) out.push(digits);
  }
  // The column holds 32 characters; keep whole numbers only.
  while (out.length > 1 && out.join(", ").length > 32) out.pop();
  return out.join(", ").slice(0, 32);
}

/** First real email in a field; drops placeholders and emails missing from the source. */
export function cleanEmail(value: string, opts: { sourceText?: string }, dropped: string[] = []): string {
  const source = opts.sourceText?.toLowerCase();
  for (const match of value.toLowerCase().match(/[^\s@,;:<>()"']+@[^\s@,;:<>()"']+\.[a-z]{2,}/g) ?? []) {
    const email = match.replace(/[.]+$/, "");
    if (DUMMY_EMAILS.has(email) || DUMMY_EMAIL_DOMAINS.test(email)) {
      dropped.push(`placeholder email ${email}`);
      continue;
    }
    if (source !== undefined && !source.includes(email)) {
      dropped.push(`email ${email} (not in your text)`);
      continue;
    }
    return email;
  }
  return "";
}

/**
 * "Rajesh ( HR )" -> name Rajesh, designation HR; "Viresh Kumar (GM- HR), mohan" -> Viresh Kumar / GM- HR;
 * "Rajesh Kumar - HR Head" -> Rajesh Kumar / HR Head.
 */
export function splitNameAndDesignation(rawName: string): { name: string; designation: string } {
  let name = rawName.replace(/^["'\s]+|["'\s,;]+$/g, "");
  let designation = "";
  const bracket = /[([]\s*([^)\]]+?)\s*[)\]]/.exec(name);
  if (bracket) {
    designation = bracket[1].trim();
    name = name.replace(bracket[0], " ");
  } else {
    // A spaced dash separates a title; "Jean-Paul" keeps its hyphen.
    const dash = /^(.+?)\s+[-\u2013\u2014]\s+(.+)$/.exec(name);
    if (dash && !/\d/.test(dash[2])) {
      name = dash[1];
      designation = dash[2].split(/[,;/]/)[0].trim();
    }
  }
  name = name.split(/[,;/]|\bor\b|&/)[0];
  return { name: name.replace(/\s+/g, " ").trim(), designation };
}

const LOWER_WORDS = new Set(["and", "of", "the", "for", "in", "at", "llp"]);

/**
 * Title-cases words written all in lower case; leaves acronyms and mixed case alone.
 * "sharma's" -> "Sharma's", "o'brien" -> "O'Brien".
 */
export function tidyCase(value: string): string {
  return value
    .replace(/\b([a-z])([a-z]*)\b/g, (word: string, first: string, rest: string, offset: number, all: string) => {
      if (LOWER_WORDS.has(word)) return word;
      // The tail of a contraction or possessive ('s, 't, 'll) stays lower case.
      if (/['\u2019]/.test(all[offset - 1] ?? "") && word.length <= 2) return word;
      return first.toUpperCase() + rest;
    })
    .replace(/^[a-z]/, (c) => c.toUpperCase());
}

function cleanPoc(
  rawName: string,
  rawDesignation: string,
  rawPhone: string,
  rawEmail: string,
  opts: CleanOptions,
  dropped: string[],
) {
  let { name, designation } = splitNameAndDesignation(rawName);
  let phone = rawPhone;
  // A name that is really a number belongs in the phone field.
  if (/\d{7,}/.test(name.replace(/\D/g, "")) && name.replace(/[\d\s+\-()]/g, "").length === 0) {
    phone = phone ? `${phone}, ${name}` : name;
    name = "";
  }
  designation = designation || rawDesignation.trim();
  // Keep a designation only when the source actually states it.
  if (
    designation &&
    designation.toLowerCase() !== DEFAULT_POC_DESIGNATION &&
    opts.sourceText !== undefined &&
    !opts.sourceText.toLowerCase().includes(designation.toLowerCase())
  ) {
    dropped.push(`designation "${designation}" (not in your text)`);
    designation = "";
  }
  const cleanName = tidyCase(name);
  const cleanPhone = cleanPhones(phone, opts, dropped);
  const cleanMail = cleanEmail(rawEmail, opts, dropped);
  const hasContact = Boolean(cleanName || cleanPhone || cleanMail);
  return {
    name: cleanName,
    designation: hasContact ? designation || DEFAULT_POC_DESIGNATION : "",
    phone: cleanPhone,
    email: cleanMail,
  };
}

/**
 * Normalizes an extraction into lead fields. Returns what was dropped so
 * the person reviewing it can see why a value is missing.
 */
export function cleanExtractedLead(
  raw: Partial<Record<keyof ExtractedLead | string, unknown>>,
  opts: CleanOptions,
): { lead: ExtractedLead; dropped: string[] } {
  const dropped: string[] = [];
  const get = (key: string) => str(raw[key]);

  const rawDate = get("renewal_date");
  let renewalDate = "";
  if (rawDate) {
    renewalDate = isValidIsoDate(rawDate) ? rawDate : (parseLooseDate(rawDate, opts.today) ?? "");
    if (!renewalDate) dropped.push(`renewal date "${rawDate}" (not a real date)`);
  }

  const poc1 = cleanPoc(get("poc_name"), get("poc_designation"), get("poc_contact_number"), get("poc_email_id"), opts, dropped);
  const poc2 = cleanPoc(get("poc2_name"), get("poc2_designation"), get("poc2_contact_number"), get("poc2_email_id"), opts, dropped);

  const subProduct = get("sub_product_name");
  const rawProduct = get("policy_product");
  const rawType = get("type").toLowerCase();
  const context = [get("client_name"), subProduct, rawProduct, get("notes")].join(" ");

  const lead: ExtractedLead = {
    client_name: tidyCase(get("client_name").replace(/^["']+|["']+$/g, "")),
    type: rawType.includes("renew") || renewalDate ? "Renewal" : "New",
    business_type: normalizeBusinessType(get("business_type"), context),
    policy_product: normalizeProduct(rawProduct || subProduct),
    sub_product_name: subProduct,
    renewal_date: renewalDate,
    address: get("address"),
    poc_name: poc1.name,
    poc_designation: poc1.designation,
    poc_contact_number: poc1.phone,
    poc_email_id: poc1.email,
    poc2_name: poc2.name,
    poc2_designation: poc2.designation,
    poc2_contact_number: poc2.phone,
    poc2_email_id: poc2.email,
    notes: get("notes"),
  };

  for (const [key, max] of Object.entries(MAX_LENGTH) as [keyof ExtractedLead, number][]) {
    const value = lead[key];
    if (typeof value === "string" && value.length > max) (lead as Record<string, string>)[key] = value.slice(0, max);
  }
  return { lead, dropped };
}
