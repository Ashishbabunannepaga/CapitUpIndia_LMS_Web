import { parseLooseDate } from "@/lib/date-parse";

// Offline fallback for AI lead intake, used when Gemini is not configured or
// every model fails. Pulls out what simple patterns can find and leaves the
// rest empty; unlike the old app it never fills in demo values.

const STOP = "(?=\\s+(?:today|yesterday|tomorrow|at|for|with|regarding|about|on|and|who|whose|his|her|their|they|is|has|wants|needs|renewal|policy)\\b|[,.;\\n]|$)";

function firstMatch(text: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (m?.[1]) return m[1].trim();
  }
  return "";
}

export function heuristicParseText(text: string, today: string): Record<string, string> {
  const client = firstMatch(text, [
    new RegExp(`\\b(?:[Cc]ompany|[Cc]lient|[Cc]orporate|[Ff]irm|[Aa]ccount)\\s*(?:[Nn]ame)?\\s*(?:is|:|-)?\\s+([A-Z][\\w&.'-]*(?:\\s+[A-Z][\\w&.'-]*)*)${STOP}`),
    new RegExp(`\\b(?:[Ff]rom|at|of)\\s+([A-Z][\\w&.'-]*(?:\\s+[A-Z][\\w&.'-]*)*)${STOP}`),
  ]);

  const pocRaw = firstMatch(text, [
    /\b[Pp][Oo][Cc](?:\s+name)?\s*(?:is|:|-)?\s+([A-Z][a-zA-Z.]*(?:\s+[A-Z][a-zA-Z.]*)?(?:\s*[([][^)\]]+[)\]])?)/,
    /\b(?:[Mm]et|[Mm]eeting|[Ss]poke|[Tt]alked|[Cc]all(?:ed)?)\s+(?:with|to)?\s*([A-Z][a-zA-Z.]*(?:\s+[A-Z][a-zA-Z.]*)?(?:\s*[([][^)\]]+[)\]])?)/,
    /\b[Cc]ontact(?:\s+person)?\s*(?:is|:|-)?\s+([A-Z][a-zA-Z.]*(?:\s+[A-Z][a-zA-Z.]*)?(?:\s*[([][^)\]]+[)\]])?)/,
  ]);

  const phones = text.match(/\+?\d[\d\s-]{8,}\d/g) ?? [];
  const emails = text.match(/[^\s@,;:<>()"']+@[^\s@,;:<>()"']+\.[a-z]{2,}/gi) ?? [];
  const renewalDate = parseLooseDate(text, today) ?? "";

  return {
    client_name: client,
    type: /renew|expir/i.test(text) || renewalDate ? "Renewal" : "New",
    business_type: "",
    policy_product: text,
    sub_product_name: "",
    renewal_date: renewalDate,
    poc_name: pocRaw,
    poc_designation: "",
    poc_contact_number: phones[0] ?? "",
    poc_email_id: emails[0] ?? "",
    poc2_name: "",
    poc2_designation: "",
    poc2_contact_number: phones[1] ?? "",
    poc2_email_id: emails[1] ?? "",
    notes: text.trim(),
  };
}
