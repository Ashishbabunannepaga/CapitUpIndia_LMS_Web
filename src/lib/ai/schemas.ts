import { BUSINESS_TYPES, LEAD_TYPES, POLICY_PRODUCTS } from "@/lib/domain";

// JSON Schemas sent to the model as strict structured output, so it returns
// exactly these fields. Every value is still validated and cleaned after.

const text = (description: string) => ({ type: "string", description });

const leadProperties = {
  client_name: text("Company name, or the person for a retail policy"),
  type: { type: "string", enum: [...LEAD_TYPES] },
  business_type: { type: "string", enum: [...BUSINESS_TYPES] },
  policy_product: { type: "string", enum: [...POLICY_PRODUCTS] },
  sub_product_name: text("Plan or detailed policy name, or empty"),
  renewal_date: text("YYYY-MM-DD or empty"),
  poc_name: text("Primary contact name or empty"),
  poc_designation: text('Stated designation, or "poc"'),
  poc_contact_number: text("Digits only, or empty"),
  poc_email_id: text("Email or empty"),
  poc2_name: text("Second contact name or empty"),
  poc2_designation: text("Second contact designation or empty"),
  poc2_contact_number: text("Digits only, or empty"),
  poc2_email_id: text("Email or empty"),
  address: text("Postal address or empty"),
  notes: text("Other useful details"),
} as const;

// OpenAI strict mode: every property is required (empty strings stand for
// "not given") and no extra properties are allowed.
const LEAD_REQUIRED = Object.keys(leadProperties);

export const leadSchema = {
  name: "lead",
  schema: {
    type: "object",
    properties: leadProperties,
    required: LEAD_REQUIRED,
    additionalProperties: false,
  },
};

export const bulkLeadsSchema = {
  name: "leads",
  schema: {
    type: "object",
    properties: {
      leads: {
        type: "array",
        items: {
          type: "object",
          properties: { source_row: { type: "integer", description: "The [n] row number from the input" }, ...leadProperties },
          required: ["source_row", ...LEAD_REQUIRED],
          additionalProperties: false,
        },
      },
    },
    required: ["leads"],
    additionalProperties: false,
  },
};

/** What is read from an uploaded policy document (src/lib/policy-check.ts checks it). */
export const policySchema = {
  name: "policy",
  schema: {
    type: "object",
    properties: {
      insured_name: text("The insured / policyholder: the company, or the person for a retail policy"),
      insurer: text("The insurance company that issued the policy"),
      policy_number: text("The policy number exactly as printed, or empty"),
      policy_product: { type: "string", enum: [...POLICY_PRODUCTS] },
      plan_name: text("The plan or product name as printed, or empty"),
      policy_start_date: text("Period of insurance from, YYYY-MM-DD, or empty"),
      policy_end_date: text("Period of insurance to (expiry), YYYY-MM-DD, or empty"),
      premium: text("Total premium payable including taxes, digits only (no commas or currency), or empty"),
      sum_insured: text("Sum insured / cover amount, digits only, or empty"),
    },
    required: [
      "insured_name",
      "insurer",
      "policy_number",
      "policy_product",
      "plan_name",
      "policy_start_date",
      "policy_end_date",
      "premium",
      "sum_insured",
    ],
    additionalProperties: false,
  },
};
