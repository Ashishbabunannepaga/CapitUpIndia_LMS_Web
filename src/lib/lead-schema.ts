import { z } from "zod";

import { BUSINESS_TYPES, DEFAULT_POC_DESIGNATION, LEAD_STATUSES, LEAD_TYPES, POLICY_PRODUCTS } from "@/lib/domain";

// Validation for the lead form. The database re-checks lengths, email shape,
// ownership and duplicate state, so this is about clear messages.

const text = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters.`).default("");

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(200)
  .refine((v) => v === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), "Enter a valid email address.")
  .default("");

const phone = z
  .string()
  .trim()
  .max(32, "Keep phone numbers under 32 characters.")
  .refine((v) => v === "" || /^[0-9+()\-\s,/]+$/.test(v), "Use digits, spaces, + or - only.")
  .default("");

export const leadFormSchema = z
  .object({
    client_name: z.string().trim().min(1, "Enter the client or company name.").max(300),
    type: z.enum(LEAD_TYPES as [string, ...string[]]).default("New"),
    business_type: z.enum(BUSINESS_TYPES as [string, ...string[]]).default("Corporate"),
    policy_product: z.enum(POLICY_PRODUCTS as [string, ...string[]]).default("Health"),
    sub_product_name: text(200),
    renewal_date: z
      .string()
      .trim()
      .refine((v) => v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v), "Use a valid date.")
      .default(""),
    poc_name: text(120),
    poc_designation: text(120),
    poc_contact_number: phone,
    poc_email_id: email,
    poc2_name: text(120),
    poc2_designation: text(120),
    poc2_contact_number: phone,
    poc2_email_id: email,
    notes: text(20000),
    status: z.enum(LEAD_STATUSES as [string, ...string[]]).default("Prospect"),
    assigned_agent_id: z.string().trim().default(""),
    confirm_duplicate: z.string().optional(),
  })
  .transform((v) => ({
    ...v,
    poc_designation: v.poc_designation || (v.poc_name ? DEFAULT_POC_DESIGNATION : ""),
    poc2_designation: v.poc2_designation || (v.poc2_name ? DEFAULT_POC_DESIGNATION : ""),
    renewal_date: v.renewal_date || null,
    assigned_agent_id: v.assigned_agent_id && v.assigned_agent_id !== "unassigned" ? v.assigned_agent_id : null,
    confirm_duplicate: v.confirm_duplicate === "on" || v.confirm_duplicate === "true",
  }));

export type LeadFormValues = z.output<typeof leadFormSchema>;

export const LEAD_FORM_FIELDS = [
  "client_name",
  "type",
  "business_type",
  "policy_product",
  "sub_product_name",
  "renewal_date",
  "poc_name",
  "poc_designation",
  "poc_contact_number",
  "poc_email_id",
  "poc2_name",
  "poc2_designation",
  "poc2_contact_number",
  "poc2_email_id",
  "notes",
  "status",
  "assigned_agent_id",
  "confirm_duplicate",
] as const;

export function formDataToObject(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of LEAD_FORM_FIELDS) {
    const value = formData.get(key);
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export const contactSchema = z
  .object({
    name: text(120),
    designation: text(120),
    phone,
    email,
  })
  .refine((v) => v.name || v.phone || v.email, { message: "Enter a name, phone or email.", path: ["name"] });
