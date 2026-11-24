import type { BusinessType, LeadStatus, LeadTag, LeadType, PolicyProduct } from "@/lib/database.types";
import { isIsoDate } from "@/lib/dates";
import { BUSINESS_TYPES, isLeadStatus, isLeadTag, isPolicyProduct, LEAD_TYPES } from "@/lib/domain";

// Leads screen filters live in the URL so views are shareable and the server
// renders the filtered list. Unknown values are ignored.

export const LEAD_VIEWS = ["table", "cards", "kanban"] as const;
export type LeadView = (typeof LEAD_VIEWS)[number];

export const RENEWAL_WINDOWS = {
  overdue: "Overdue",
  "7": "Next 7 days",
  "30": "Next 30 days",
  "90": "Next 90 days",
  none: "No renewal date",
} as const;
export type RenewalWindow = keyof typeof RENEWAL_WINDOWS;

/** Closed outcomes, offered in the Status filter (and followed by the export). */
export const OUTCOME_FILTERS = {
  won: "Clients (Closed Won or Auto Renewed)",
  lost: "Closed Lost",
  closed: "Any closed (awaiting policy, won, auto renewed or lost)",
} as const;
export type OutcomeFilter = keyof typeof OUTCOME_FILTERS;

export const LEAD_SORTS = {
  updated: "Recently updated",
  name: "Client name A-Z",
  renewal_asc: "Renewal date, earliest",
  renewal_desc: "Renewal date, latest",
  created: "Newest first",
} as const;
export type LeadSort = keyof typeof LEAD_SORTS;

export type LeadFilters = {
  view: LeadView;
  q: string;
  status: LeadStatus | null;
  product: PolicyProduct | null;
  type: LeadType | null;
  /** Corporate or Retail, or null for both. */
  business: BusinessType | null;
  /** Agent id, "unassigned", or null for everyone (admins only). */
  agent: string | null;
  renewal: RenewalWindow | null;
  duplicates: boolean;
  /** Only open leads with no activity for longer than the stale threshold. */
  stale: boolean;
  tag: LeadTag | null;
  /** Clients (Closed Won/Auto Renewed), Closed Lost, or any closed. */
  outcome: OutcomeFilter | null;
  /** Policy start date range (YYYY-MM-DD, inclusive) from the lead's transactions. */
  startFrom: string | null;
  startTo: string | null;
  sort: LeadSort;
  /** 1-based page of the table and card views. */
  page: number;
};

type RawParams = Record<string, string | string[] | undefined>;

function one(params: RawParams, key: string): string {
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

export function parseLeadFilters(params: RawParams): LeadFilters {
  const view = one(params, "view");
  const status = one(params, "status");
  const product = one(params, "product");
  const type = one(params, "type");
  const business = one(params, "business");
  const renewal = one(params, "renewal");
  const sort = one(params, "sort");
  const agent = one(params, "agent");

  return {
    view: (LEAD_VIEWS as readonly string[]).includes(view) ? (view as LeadView) : "table",
    q: one(params, "q").slice(0, 100),
    status: isLeadStatus(status) ? status : null,
    product: isPolicyProduct(product) ? product : null,
    type: (LEAD_TYPES as readonly string[]).includes(type) ? (type as LeadType) : null,
    business: (BUSINESS_TYPES as readonly string[]).includes(business) ? (business as BusinessType) : null,
    agent: agent === "unassigned" || /^[0-9a-f-]{36}$/i.test(agent) ? agent : null,
    renewal: Object.hasOwn(RENEWAL_WINDOWS, renewal) ? (renewal as RenewalWindow) : null,
    duplicates: one(params, "duplicates") === "1",
    stale: one(params, "stale") === "1",
    tag: isLeadTag(one(params, "tag")) ? (one(params, "tag") as LeadTag) : null,
    outcome: Object.hasOwn(OUTCOME_FILTERS, one(params, "outcome")) ? (one(params, "outcome") as OutcomeFilter) : null,
    startFrom: isIsoDate(one(params, "start_from")) ? one(params, "start_from") : null,
    startTo: isIsoDate(one(params, "start_to")) ? one(params, "start_to") : null,
    sort: Object.hasOwn(LEAD_SORTS, sort) ? (sort as LeadSort) : "updated",
    page: parsePage(one(params, "page")),
  };
}

const MAX_PAGE = 10_000;

function parsePage(value: string): number {
  const page = /^\d{1,5}$/.test(value) ? Number(value) : 1;
  return Math.min(Math.max(page, 1), MAX_PAGE);
}

/** Builds a /leads URL from filters, dropping defaults. */
export function leadsHref(filters: Partial<LeadFilters>): string {
  const params = new URLSearchParams();
  if (filters.view && filters.view !== "table") params.set("view", filters.view);
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.product) params.set("product", filters.product);
  if (filters.type) params.set("type", filters.type);
  if (filters.business) params.set("business", filters.business);
  if (filters.agent) params.set("agent", filters.agent);
  if (filters.renewal) params.set("renewal", filters.renewal);
  if (filters.duplicates) params.set("duplicates", "1");
  if (filters.stale) params.set("stale", "1");
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.outcome) params.set("outcome", filters.outcome);
  if (filters.startFrom) params.set("start_from", filters.startFrom);
  if (filters.startTo) params.set("start_to", filters.startTo);
  if (filters.sort && filters.sort !== "updated") params.set("sort", filters.sort);
  if (filters.page && filters.page > 1 && filters.view !== "kanban") params.set("page", String(filters.page));
  const query = params.toString();
  return query ? `/leads?${query}` : "/leads";
}

/**
 * Search terms for the leads list, safe to put inside a PostgREST or()
 * filter: characters with meaning there are stripped. A phone-like query
 * also yields its bare digits, so "98450 12345" finds "9845012345".
 */
export function searchTerms(q: string): string[] {
  const term = q.replace(/[,()*%\\:"']/g, " ").replace(/\s+/g, " ").trim();
  if (!term) return [];
  const digits = term.replace(/\D/g, "");
  const phoneLike = /^[\d\s+\-/]+$/.test(term) && digits.length >= 4;
  return phoneLike && digits !== term ? [term, digits] : [term];
}
