import type { BusinessType, LeadStatus, LeadType, PolicyProduct } from "@/lib/database.types";

// Business vocabulary shared by every screen. Values match the database enums.

export const POLICY_PRODUCTS: readonly PolicyProduct[] = [
  "Health",
  "Fire or Property",
  "Life",
  "Motor",
  "Liability",
  "Travel",
  "Marine",
  "Credit",
];

export const LEAD_STATUSES: readonly LeadStatus[] = [
  "Prospect",
  "Quoted",
  "Active Client",
  "Follow-up",
  "Closed Won",
  "Closed Lost",
];

export const LEAD_TYPES: readonly LeadType[] = ["New", "Renewal"];

export const BUSINESS_TYPES: readonly BusinessType[] = ["Corporate", "Retail"];

/** Designation used when the source does not state one explicitly. */
export const DEFAULT_POC_DESIGNATION = "poc";

/** Countdown milestones generated for every renewal date (see the renewal migration). */
export const RENEWAL_MILESTONES = [
  "T-30 Days",
  "T-10 Days",
  "T-5 Days",
  "T-3 Days",
  "T-24 Hours",
  "T-10 Hours",
  "T-1 Hour",
  "T-30 Minutes",
  "T-5 Minutes",
] as const;

export const BUSINESS_TIMEZONE = "Asia/Kolkata";

/** Renders a note as "[Agent Name - DD MMM YYYY, HH:mm]: Note" in business time. */
export function formatNoteLine(agentName: string, createdAt: string | Date, content: string): string {
  const date = new Date(createdAt);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: BUSINESS_TIMEZONE,
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .find((p) => p.type === type)?.value ?? "";
  return `[${agentName} - ${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")}]: ${content}`;
}

/** Statuses that end the pipeline; their renewals and follow-ups are no longer chased. */
export const CLOSED_STATUSES: readonly LeadStatus[] = ["Closed Won", "Closed Lost"];

/** Tailwind classes per status, shared by badges, Kanban columns and charts. */
export const STATUS_STYLES: Record<LeadStatus, { badge: string; dot: string }> = {
  Prospect: { badge: "border-slate-200 bg-slate-100 text-slate-700", dot: "bg-slate-400" },
  Quoted: { badge: "border-sky-200 bg-sky-50 text-sky-700", dot: "bg-sky-500" },
  "Active Client": { badge: "border-brand-200 bg-brand-50 text-brand-800", dot: "bg-brand-500" },
  "Follow-up": { badge: "border-amber-200 bg-amber-50 text-amber-800", dot: "bg-amber-500" },
  "Closed Won": { badge: "border-green-300 bg-green-100 text-green-800", dot: "bg-green-600" },
  "Closed Lost": { badge: "border-rose-200 bg-rose-50 text-rose-700", dot: "bg-rose-500" },
};

/** The same status hues as hex, for SVG charts. */
export const STATUS_COLORS: Record<LeadStatus, string> = {
  Prospect: "#94a3b8",
  Quoted: "#0ea5e9",
  "Active Client": "#1aab93",
  "Follow-up": "#f59e0b",
  "Closed Won": "#16a34a",
  "Closed Lost": "#f43f5e",
};

export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === "string" && (LEAD_STATUSES as readonly string[]).includes(value);
}

export function isPolicyProduct(value: unknown): value is PolicyProduct {
  return typeof value === "string" && (POLICY_PRODUCTS as readonly string[]).includes(value);
}

// Calendar colours, as in the Android app's planner: renewals split into GMC
// (corporate) and retail, entries for active clients, and everything else as
// tasks. One entry can carry two colours (a renewal for an active client).
export const CALENDAR_CATEGORIES = ["gmc_renewal", "retail_renewal", "active_client", "task"] as const;
export type CalendarCategory = (typeof CALENDAR_CATEGORIES)[number];

export const CALENDAR_CATEGORY_LABELS: Record<CalendarCategory, string> = {
  gmc_renewal: "GMC Renewal",
  retail_renewal: "Retail Renewal",
  active_client: "Active Clients",
  task: "Tasks",
};

/** Tailwind classes per calendar colour: a pill for day cells, a dot for lists and the legend. */
export const CALENDAR_CATEGORY_STYLES: Record<CalendarCategory, { pill: string; dot: string; chip: string }> = {
  gmc_renewal: { pill: "bg-indigo-100 text-indigo-900", dot: "bg-indigo-600", chip: "border-indigo-300 bg-indigo-600 text-white" },
  retail_renewal: { pill: "bg-rose-100 text-rose-900", dot: "bg-rose-500", chip: "border-rose-300 bg-rose-500 text-white" },
  active_client: { pill: "bg-brand-100 text-brand-900", dot: "bg-brand-500", chip: "border-brand-300 bg-brand-600 text-white" },
  task: { pill: "bg-orange-100 text-orange-900", dot: "bg-orange-500", chip: "border-orange-300 bg-orange-500 text-white" },
};

/**
 * The colours of one calendar entry. A renewal is retail when its lead is a
 * retail account or a motor policy (the old app also treated 2- and
 * 4-wheeler and motor entries as retail), otherwise GMC. Entries for an
 * active client also get that colour; anything else that is not a renewal
 * is a task.
 */
export function calendarCategories(
  isRenewal: boolean,
  lead: { business_type: BusinessType; policy_product: PolicyProduct; status: LeadStatus } | null,
): CalendarCategory[] {
  const active = lead?.status === "Active Client";
  if (isRenewal) {
    const retail = lead?.business_type === "Retail" || lead?.policy_product === "Motor";
    return [retail ? "retail_renewal" : "gmc_renewal", ...(active ? (["active_client"] as const) : [])];
  }
  return [active ? "active_client" : "task"];
}

/** Ways an agent can reach a POC from the lead page; each click is logged on the lead. */
export const CONTACT_CHANNELS = ["call", "whatsapp", "email"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];
export const CONTACT_CHANNEL_LABELS: Record<ContactChannel, string> = { call: "Call", whatsapp: "WhatsApp", email: "Email" };
export function isContactChannel(value: unknown): value is ContactChannel {
  return typeof value === "string" && (CONTACT_CHANNELS as readonly string[]).includes(value);
}
