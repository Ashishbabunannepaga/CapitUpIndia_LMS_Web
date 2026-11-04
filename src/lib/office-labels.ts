// Plain-language labels for the office portal, the same wording the office
// itself uses, so the team reads the same words in both places.

export type Tone = "info" | "accent" | "warn" | "good" | "muted" | "risk";

export const OFFICE_TYPE: Record<string, string> = { health: "Health", motor: "Motor", life: "Term life", unsure: "Not specified" };

export const OFFICE_LEAD_STEPS: { id: string; label: string; tone: Tone; hint: string }[] = [
  { id: "new", label: "New", tone: "info", hint: "Nobody has called yet" },
  { id: "contacted", label: "Contacted", tone: "accent", hint: "Spoke to the client" },
  { id: "follow_up", label: "Follow-up", tone: "warn", hint: "Needs another call or quotes" },
  { id: "converted", label: "Became a client", tone: "good", hint: "Bought or renewed with Capitup" },
  { id: "closed", label: "Closed", tone: "muted", hint: "Not interested or unreachable" },
];

export const OFFICE_RENEWAL_STEPS: { id: string; label: string; tone: Tone }[] = [
  { id: "to_contact", label: "To contact", tone: "info" },
  { id: "contacted", label: "Contacted", tone: "accent" },
  { id: "quoted", label: "Quote sent", tone: "warn" },
  { id: "renewed", label: "Renewed with Capitup", tone: "good" },
  { id: "lost", label: "Not renewing with us", tone: "muted" },
];

export const OFFICE_POLICY_STATUS: Record<string, [string, Tone]> = {
  extracted: ["Read successfully", "good"],
  queued: ["Waiting to be read", "info"],
  processing: ["Reading scanned pages", "info"],
  unsupported: ["Needs manual review", "warn"],
  failed: ["Could not be read", "risk"],
  received: ["Upload not finished", "muted"],
  stored: ["Upload not finished", "muted"],
};

export const OFFICE_METHOD: Record<string, string> = { text: "Digital copy", ocr: "Scanned copy", mixed: "Partly scanned" };

export const OFFICE_SOURCE: Record<string, string> = {
  policy: "Gap report",
  whatsapp: "Report on WhatsApp",
  appointment: "Book-a-call page",
  contact: "Contact form",
  game: "Protection game",
};

export const OFFICE_CONSENT: Record<string, string> = {
  policy_analysis: "Policy check",
  requested_follow_up: "Call request",
  save_game: "Saved game result",
  deletion: "Data deletion",
};

export const TONE_CLASS: Record<Tone, string> = {
  info: "border-sky-200 bg-sky-50 text-sky-800",
  accent: "border-brand-200 bg-brand-50 text-brand-800",
  warn: "border-amber-200 bg-amber-50 text-amber-800",
  good: "border-emerald-200 bg-emerald-50 text-emerald-800",
  muted: "border-border bg-muted text-muted-foreground",
  risk: "border-rose-200 bg-rose-50 text-rose-800",
};

export function leadStep(id?: string | null) {
  return OFFICE_LEAD_STEPS.find((s) => s.id === id) ?? OFFICE_LEAD_STEPS[0];
}

export function renewalStep(id?: string | null) {
  return OFFICE_RENEWAL_STEPS.find((s) => s.id === id) ?? OFFICE_RENEWAL_STEPS[0];
}

export function policyStatus(id?: string | null): [string, Tone] {
  return OFFICE_POLICY_STATUS[id ?? ""] ?? ["Processing", "info"];
}

export function officeType(id?: string | null): string {
  return OFFICE_TYPE[id || "unsure"] ?? OFFICE_TYPE.unsure;
}

/** wa.me link for an Indian or international number; null when it is not a phone number. */
export function whatsappLink(phone?: string | null): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return `https://wa.me/${digits.length === 10 ? `91${digits}` : digits}`;
}

/** The office's suggested renewal message. */
export function renewalMessage(name: string | null | undefined, policyType: string | null, expiresOn: string): string {
  const first = name?.trim() ? ` ${name.trim().split(/\s+/)[0]}` : "";
  const date = new Date(`${expiresOn}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "long" });
  const type = policyType && OFFICE_TYPE[policyType] ? `${OFFICE_TYPE[policyType]} ` : "";
  return `Hello${first}, this is Capitup. Your ${type}policy is due for renewal on ${date}. We can compare renewal quotes from several insurers and help fix the gaps in your report. When is a good time to call?`;
}

/** The office's message for sending a gap report over WhatsApp. */
export function reportMessage(name: string | null | undefined): string {
  const first = name?.trim() ? ` ${name.trim().split(/\s+/)[0]}` : "";
  return `Hello${first}, this is Capitup. Thank you for checking your policy with us. We have your gap report ready; when is a good time to go through it together?`;
}

const whenFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

export function officeWhen(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : whenFormat.format(d);
}

export function officeAgo(value?: string | null, now = Date.now()): string {
  if (!value) return "";
  const minutes = Math.round((now - new Date(value).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function rupees(n: unknown): string {
  return typeof n === "number" ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n) : "—";
}
