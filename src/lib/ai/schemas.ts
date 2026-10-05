import { BUSINESS_TYPES, LEAD_TYPES, POLICY_PRODUCTS } from "@/lib/domain";

// JSON Schemas sent to Gemini as responseJsonSchema, so the model returns
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

const LEAD_REQUIRED = ["client_name", "type", "business_type", "policy_product", "renewal_date", "poc_name", "poc_designation", "poc_contact_number", "poc_email_id", "notes"];

export const leadSchema = {
  type: "object",
  properties: leadProperties,
  required: LEAD_REQUIRED,
  propertyOrdering: Object.keys(leadProperties),
};

export const bulkLeadsSchema = {
  type: "object",
  properties: {
    leads: {
      type: "array",
      items: {
        type: "object",
        properties: { source_row: { type: "integer", description: "The [n] row number from the input" }, ...leadProperties },
        required: ["source_row", ...LEAD_REQUIRED],
        propertyOrdering: ["source_row", ...Object.keys(leadProperties)],
      },
    },
  },
  required: ["leads"],
};
