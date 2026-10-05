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
