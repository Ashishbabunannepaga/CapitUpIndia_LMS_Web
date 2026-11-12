import type { BusinessType, LeadStatus, LeadTag, LeadType, PolicyProduct } from "@/lib/database.types";

// Business vocabulary shared by every screen. Values match the database enums.

/** What a new lead starts with until someone knows the product. */
export const UNSPECIFIED_PRODUCT: PolicyProduct = "Not Specified";

export const POLICY_PRODUCTS: readonly PolicyProduct[] = [
  "Not Specified",
  "Health",
  "Fire or Property",
  "Life",
  "Motor",
  "Liability",
  "Travel",
  "Marine",
  "Credit",
];

// There is no "Active Client" status: a Closed Won lead is an active client
// (it was folded into Closed Won in migration 0009).
export const LEAD_STATUSES: readonly LeadStatus[] = [
  "Prospect",
  "Quoted",
  "Follow-up",
  "Closed Won",
  "Closed Lost",
];

export const LEAD_TYPES: readonly LeadType[] = ["New", "Renewal", "Rollover"];

/** A Renewal or Rollover lead needs its policy expiry date; a New lead may have none. */
export function needsRenewalDate(type: string): boolean {
  return type === "Renewal" || type === "Rollover";
}

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

let noteLineFormat: Intl.DateTimeFormat | undefined;

/** Renders a note as "[Agent Name - DD MMM YYYY, HH:mm]: Note" in business time. */
export function formatNoteLine(agentName: string, createdAt: string | Date, content: string): string {
  noteLineFormat ??= new Intl.DateTimeFormat("en-GB", {
    timeZone: BUSINESS_TIMEZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = noteLineFormat.formatToParts(new Date(createdAt));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `[${agentName} - ${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")}]: ${content}`;
}

/** The status that makes a lead an active client of CapitUp. */
export const ACTIVE_CLIENT_STATUS: LeadStatus = "Closed Won";

/**
 * Statuses whose renewals are no longer chased: only Closed Lost. A Closed
 * Won lead is an active client, so its renewal countdown, reminders and
 * overdue warnings carry on.
 */
export const CLOSED_STATUSES: readonly LeadStatus[] = ["Closed Lost"];

/** Tailwind classes per status, shared by badges, Kanban columns and charts. */
export const STATUS_STYLES: Record<LeadStatus, { badge: string; dot: string }> = {
  Prospect: { badge: "border-slate-200 bg-slate-100 text-slate-700", dot: "bg-slate-400" },
  Quoted: { badge: "border-sky-200 bg-sky-50 text-sky-700", dot: "bg-sky-500" },
  "Follow-up": { badge: "border-amber-200 bg-amber-50 text-amber-800", dot: "bg-amber-500" },
  "Closed Won": { badge: "border-green-300 bg-green-100 text-green-800", dot: "bg-green-600" },
  "Closed Lost": { badge: "border-rose-200 bg-rose-50 text-rose-700", dot: "bg-rose-500" },
};

/** The same status hues as hex, for SVG charts. */
export const STATUS_COLORS: Record<LeadStatus, string> = {
  Prospect: "#94a3b8",
  Quoted: "#0ea5e9",
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
// (corporate) and retail, entries for active clients (Closed Won), meetings,
// and everything else as tasks. One entry can carry two colours (a renewal or
// a meeting for an active client).
export const CALENDAR_CATEGORIES = ["gmc_renewal", "retail_renewal", "active_client", "meeting", "task"] as const;
export type CalendarCategory = (typeof CALENDAR_CATEGORIES)[number];

export const CALENDAR_CATEGORY_LABELS: Record<CalendarCategory, string> = {
  gmc_renewal: "GMC Renewal",
  retail_renewal: "Retail Renewal",
  active_client: "Active Clients",
  meeting: "Meetings",
  task: "Tasks",
};

/** Tailwind classes per calendar colour: a pill for day cells, a dot for lists and the legend. */
export const CALENDAR_CATEGORY_STYLES: Record<CalendarCategory, { pill: string; dot: string; chip: string }> = {
  gmc_renewal: { pill: "bg-indigo-100 text-indigo-900", dot: "bg-indigo-600", chip: "border-indigo-300 bg-indigo-600 text-white" },
  retail_renewal: { pill: "bg-rose-100 text-rose-900", dot: "bg-rose-500", chip: "border-rose-300 bg-rose-500 text-white" },
  active_client: { pill: "bg-brand-100 text-brand-900", dot: "bg-brand-500", chip: "border-brand-300 bg-brand-600 text-white" },
  meeting: { pill: "bg-violet-100 text-violet-900", dot: "bg-violet-600", chip: "border-violet-300 bg-violet-600 text-white" },
  task: { pill: "bg-orange-100 text-orange-900", dot: "bg-orange-500", chip: "border-orange-300 bg-orange-500 text-white" },
};

/**
 * What a day cell shows for one entry. A retail renewal for an active client
 * (Closed Won) stays one "retail" tile but turns green ("retail_won") instead
 * of showing a red retail tile next to a green active one.
 */
export type CalendarPill = CalendarCategory | "retail_won";

export function calendarPills(categories: readonly CalendarCategory[]): CalendarPill[] {
  if (categories.includes("retail_renewal") && categories.includes("active_client")) {
    return ["retail_won", ...categories.filter((c) => c !== "retail_renewal" && c !== "active_client")];
  }
  return [...categories];
}

/** Order, labels and colours of day-cell tiles; the green retail tile sits next to the red one. */
export const CALENDAR_PILLS: readonly CalendarPill[] = [
  "gmc_renewal",
  "retail_renewal",
  "retail_won",
  "active_client",
  "meeting",
  "task",
];
export const CALENDAR_PILL_LABELS: Record<CalendarPill, string> = {
  ...CALENDAR_CATEGORY_LABELS,
  retail_won: "Retail Renewal (Closed Won)",
};
export const CALENDAR_PILL_STYLES: Record<CalendarPill, { pill: string; dot: string }> = {
  ...CALENDAR_CATEGORY_STYLES,
  retail_won: { pill: "bg-emerald-100 text-emerald-900", dot: "bg-emerald-500" },
};

/** Whether a tile shows under a filter chip: a green retail tile counts as retail and as an active client. */
export function pillMatchesFilter(pill: CalendarPill, filter: "all" | CalendarCategory): boolean {
  if (filter === "all" || pill === filter) return true;
  return pill === "retail_won" && (filter === "retail_renewal" || filter === "active_client");
}

/** What people put on the calendar besides renewals. */
export const EVENT_KINDS = ["task", "meeting"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const EVENT_KIND_LABELS: Record<EventKind, string> = { task: "Task", meeting: "Meeting" };
export function isEventKind(value: unknown): value is EventKind {
  return typeof value === "string" && (EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * The colours of one calendar entry. A renewal is retail when its lead is a
 * retail account or a motor policy (the old app also treated 2- and
 * 4-wheeler and motor entries as retail), otherwise GMC. A meeting is a
 * meeting. Renewals and meetings for an active client (Closed Won) also get
 * that colour; any other task for one is coloured as the client's.
 */
export function calendarCategories(
  isRenewal: boolean,
  lead: { business_type: BusinessType; policy_product: PolicyProduct; status: LeadStatus } | null,
  kind: EventKind = "task",
): CalendarCategory[] {
  const active = lead?.status === ACTIVE_CLIENT_STATUS;
  const alsoActive = active ? (["active_client"] as const) : [];
  if (isRenewal) {
    const retail = lead?.business_type === "Retail" || lead?.policy_product === "Motor";
    return [retail ? "retail_renewal" : "gmc_renewal", ...alsoActive];
  }
  if (kind === "meeting") return ["meeting", ...alsoActive];
  return [active ? "active_client" : "task"];
}

/** Ways an agent can reach a POC from the lead page; each click is logged on the lead. */
export const CONTACT_CHANNELS = ["call", "whatsapp", "email"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];
export const CONTACT_CHANNEL_LABELS: Record<ContactChannel, string> = { call: "Call", whatsapp: "WhatsApp", email: "Email" };
export function isContactChannel(value: unknown): value is ContactChannel {
  return typeof value === "string" && (CONTACT_CHANNELS as readonly string[]).includes(value);
}

/** What the admins' activity log tracks (src/server/data/activity.ts). */
export const ACTIVITY_KINDS = [
  "lead_created",
  "status_changed",
  "lead_assigned",
  "lead_edited",
  "card_uploaded",
  "note_added",
  "task_created",
  "task_completed",
  "contact",
  "lead_deleted",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  lead_created: "Created lead",
  status_changed: "Changed status",
  lead_assigned: "Reassigned lead",
  lead_edited: "Edited lead",
  card_uploaded: "Uploaded visiting card",
  note_added: "Added note",
  task_created: "Created task",
  task_completed: "Completed task",
  contact: "Contacted client",
  lead_deleted: "Deleted lead",
};
export function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === "string" && (ACTIVITY_KINDS as readonly string[]).includes(value);
}

/** Labels agents put on a lead (the lead_tags table allows exactly these). */
export const LEAD_TAGS: readonly LeadTag[] = ["Hot", "VIP", "Price sensitive", "Referral", "Cold"];

export const TAG_STYLES: Record<LeadTag, string> = {
  Hot: "border-red-200 bg-red-50 text-red-700",
  VIP: "border-gold-300 bg-gold-50 text-gold-800",
  "Price sensitive": "border-violet-200 bg-violet-50 text-violet-700",
  Referral: "border-brand-200 bg-brand-50 text-brand-800",
  Cold: "border-sky-200 bg-sky-50 text-sky-700",
};

export function isLeadTag(value: unknown): value is LeadTag {
  return typeof value === "string" && (LEAD_TAGS as readonly string[]).includes(value);
}

/** Statuses that are finished pipeline work: never "stale" and not counted as open workload. */
export const DONE_STATUSES: readonly LeadStatus[] = ["Closed Won", "Closed Lost"];

/** Days without a note, status change, task or contact before a lead is flagged stale (admins can change it). */
export const DEFAULT_STALE_DAYS = 7;

/** Snooze choices for an overdue task on My Day, in days. */
export const SNOOZE_DAYS = [1, 3, 7] as const;
export type SnoozeDays = (typeof SNOOZE_DAYS)[number];
