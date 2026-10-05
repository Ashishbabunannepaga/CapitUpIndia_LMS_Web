import { formatDate } from "@/lib/dates";
import { POLICY_PRODUCTS } from "@/lib/domain";

// Gemini prompts, adapted from the existing app (spec/gemini-prompts.md):
// today's date is injected instead of the app's hard-coded "June 10, 2026",
// the full product list is used, explicit designations such as Director are
// kept, and the structure is enforced with a response schema.

const PRODUCTS = POLICY_PRODUCTS.join(", ");

function dateContext(today: string): string {
  const year = Number(today.slice(0, 4));
  return `Today is ${formatDate(today)} (${today}, India). A date or month given without a year means its next occurrence: a month earlier than the current month is in ${year + 1}; the current month and later months are in ${year}.`;
}

const LEAD_FIELD_RULES = `- client_name: the company name, or the person's name for an individual (retail) policy.
- type: "Renewal" if a renewal, expiry or renewal date is mentioned, otherwise "New".
- business_type: "Corporate" for companies, "Retail" for individuals, families or personal vehicles.
- policy_product: exactly one of ${PRODUCTS}. "Fire" or "Property" means "Fire or Property"; workmen's compensation (WC) and other liability covers mean "Liability". Use "Health" only when the text is about health or does not say.
- sub_product_name: any plan, scheme or detailed policy name (e.g. "Floater Scheme", "Cargo Transit", "GMC"); empty if none.
- renewal_date: YYYY-MM-DD. Use the 1st of the month when only a month is given. Empty if no date is given; never guess one.
- poc_name / poc_designation / poc_contact_number / poc_email_id: the primary contact. The designation is only what the text states (e.g. "Rajesh (Director)" gives "Director"); otherwise "poc". Phone numbers are digits only, 10 digits for Indian mobiles.
- poc2_*: a second contact person if one is mentioned, otherwise empty.
- notes: other useful details and the agent's feedback (current insurer, premium, family size, next steps).
- Never invent phone numbers, emails, dates or names. Leave a field as "" when the text does not contain it.`;

export function leadIntakePrompt(today: string): string {
  return `You are the lead extraction assistant for CapitUp India, an insurance broker. Extract one insurance lead from a sales agent's messy note or dictation.
${dateContext(today)}

Rules:
${LEAD_FIELD_RULES}`;
}

export function visitingCardPrompt(today: string): string {
  return `You are reading a business (visiting) card for CapitUp India, an insurance broker. Extract the company and the person on the card as an insurance lead.
${dateContext(today)}

Rules:
- client_name: the company name exactly as printed.
- poc_name: the person's full name. poc_designation: their printed title (e.g. Director, Account Head), or "poc" if none is printed.
- poc_contact_number: the primary mobile number, digits only. Put any other numbers in notes.
- poc_email_id: the email printed on the card.
- address: the postal address as printed, on one line.
- notes: website, other phone numbers, GST number, tagline or anything else useful, one item per line.
- type is "New", business_type is "Corporate", policy_product is "Health" unless the card clearly says otherwise; renewal_date is empty.
- Never invent anything that is not printed on the card. Ignore obvious placeholder or sample data. Leave unknown fields as "".`;
}

export function bulkMappingPrompt(today: string): string {
  return `You are a spreadsheet mapping expert for CapitUp India's insurance CRM. An administrator pasted rows from an Excel or CSV sheet. Map EVERY row to one lead. Do not skip, merge, summarize or reorder rows.

Each input row starts with its row number in square brackets, e.g. "[12]". Return that number as source_row.
${dateContext(today)}

Common sheet layouts:
- Core sheet: NAME OF THE CLIENT, CONTACT DETAILS, CONTACT PERSON, DATE OF RENEWAL, REMARKS, STATUS.
- Location sheet: Sr no, Insured Name, Type of Policy (Package or WC), Date of referral, Location/Vertical, Contact details, Name, Remarks, Status.

Rules:
- client_name: the company or insured name ("Insured Name" in the location sheet).
- type: "Renewal" if a renewal date, expiry or renewal month is given, otherwise "New".
- business_type: "Retail" for vehicles (4WHEELER, 2WHEELER, car, motor), individual policies or rows that name only a person; otherwise "Corporate".
- policy_product: exactly one of ${PRODUCTS}. "Group health insurance" is Health; "WC" or workmen's compensation is Liability; "Package" is Fire or Property. Default to Health.
- sub_product_name: the raw policy description from the sheet (e.g. "Group health insurance", "WC").
- renewal_date: YYYY-MM-DD. "may renewal" or "May month" means the 1st of the next May; "23 rd Feb Renewal", "20-Apr" and "Apr-15" are that day in its next occurrence; "09-05-2023" is day-month-year. If an email sits in the date column, put it in poc_email_id instead. Empty if none.
- poc_name: only the person's clean name: "Rajesh ( HR )" gives "Rajesh", "Viresh Kumar ( GM- HR ), mohan" gives "Viresh Kumar".
- poc_designation: the role written in brackets next to the name ("HR", "GM- HR", "Director"); otherwise "poc".
- poc_contact_number and poc_email_id: only values present in the row. Never invent numbers like 9999999999 or 9876543210, or emails.
- address: the Location/Vertical or address column, if any.
- notes: Remarks, Status and every other column that does not fit above, formatted as "Header: value" lines. Never drop location details.`;
}

export const FOLLOW_UP_TONES = {
  professional: { label: "Professional", instruction: "Professional, friendly and assertive." },
  warm: { label: "Warm", instruction: "Warm and personal, as if writing to someone you have met; still professional." },
  concise: { label: "Concise", instruction: "As short and direct as possible: two sentences at most." },
  benefit: {
    label: "Benefit-focused",
    instruction: "Lead with one concrete benefit to the client (better cover, a smoother renewal, cost control), using only what the context supports.",
  },
} as const;

export type FollowUpTone = keyof typeof FOLLOW_UP_TONES;

export function isFollowUpTone(value: unknown): value is FollowUpTone {
  return typeof value === "string" && value in FOLLOW_UP_TONES;
}

export function followUpPrompt(tone: FollowUpTone, senderName: string): string {
  return `You are an expert enterprise sales assistant for CapitUp India, an insurance broker. Write a short follow-up message from the agent to the client's contact, suitable for WhatsApp or email.
Rules:
- Under 50 words.
- Tone: ${FOLLOW_UP_TONES[tone].instruction}
- Address the contact by first name if known.
- Use only facts from the context; do not invent premiums, dates, discounts or names.
- No placeholders such as [Your Name] or [Company]. End with "Regards, ${senderName}".
- Plain text only: no subject line, no markdown.`;
}

export function rephrasePrompt(tone: FollowUpTone, senderName: string): string {
  return `${followUpPrompt(tone, senderName)}
- Rewrite the previous draft into a clearly different version (different opening, structure and wording) that keeps the same intent.`;
}
