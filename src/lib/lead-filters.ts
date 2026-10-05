import type { LeadStatus, LeadType, PolicyProduct } from "@/lib/database.types";
import { isLeadStatus, isPolicyProduct, LEAD_TYPES } from "@/lib/domain";

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
  /** Agent id, "unassigned", or null for everyone (admins only). */
  agent: string | null;
  renewal: RenewalWindow | null;
  duplicates: boolean;
  sort: LeadSort;
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
  const renewal = one(params, "renewal");
  const sort = one(params, "sort");
  const agent = one(params, "agent");

  return {
    view: (LEAD_VIEWS as readonly string[]).includes(view) ? (view as LeadView) : "table",
    q: one(params, "q").slice(0, 100),
    status: isLeadStatus(status) ? status : null,
    product: isPolicyProduct(product) ? product : null,
    type: (LEAD_TYPES as readonly string[]).includes(type) ? (type as LeadType) : null,
    agent: agent === "unassigned" || /^[0-9a-f-]{36}$/i.test(agent) ? agent : null,
    renewal: renewal in RENEWAL_WINDOWS ? (renewal as RenewalWindow) : null,
    duplicates: one(params, "duplicates") === "1",
    sort: sort in LEAD_SORTS ? (sort as LeadSort) : "updated",
  };
}

/** Builds a /leads URL from filters, dropping defaults. */
export function leadsHref(filters: Partial<LeadFilters>): string {
  const params = new URLSearchParams();
  if (filters.view && filters.view !== "table") params.set("view", filters.view);
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.product) params.set("product", filters.product);
  if (filters.type) params.set("type", filters.type);
  if (filters.agent) params.set("agent", filters.agent);
  if (filters.renewal) params.set("renewal", filters.renewal);
  if (filters.duplicates) params.set("duplicates", "1");
  if (filters.sort && filters.sort !== "updated") params.set("sort", filters.sort);
  const query = params.toString();
  return query ? `/leads?${query}` : "/leads";
}
