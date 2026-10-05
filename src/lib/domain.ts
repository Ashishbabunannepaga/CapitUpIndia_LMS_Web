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
  Quoted: { badge: "border-indigo-200 bg-indigo-50 text-indigo-700", dot: "bg-indigo-500" },
  "Active Client": { badge: "border-emerald-200 bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  "Follow-up": { badge: "border-amber-200 bg-amber-50 text-amber-800", dot: "bg-amber-500" },
  "Closed Won": { badge: "border-green-300 bg-green-100 text-green-800", dot: "bg-green-600" },
  "Closed Lost": { badge: "border-rose-200 bg-rose-50 text-rose-700", dot: "bg-rose-500" },
};

export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === "string" && (LEAD_STATUSES as readonly string[]).includes(value);
}

export function isPolicyProduct(value: unknown): value is PolicyProduct {
  return typeof value === "string" && (POLICY_PRODUCTS as readonly string[]).includes(value);
}
