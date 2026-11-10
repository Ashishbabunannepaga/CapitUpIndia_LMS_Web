import "server-only";

// The CapitUp client app's leads feed (GET /api/v1/partner/leads on the app's
// FastAPI backend), as seen from the LMS server.
//
// Only app users who ticked "CapitUp may contact me" come through with contact
// details. Users who later withdraw (or delete their account) come through as
// "withdrawn" with no personal data, so the LMS can stop calling them.
//
// Config (Worker secrets): APP_API_URL, e.g. https://api.capitup.in/api/v1, and
// APP_LEADS_TOKEN, the same value as the app server's LEADS_API_TOKEN.
// Reads are cached per Worker isolate for CACHE_MS to stay inside the Free plan.

const CACHE_MS = 60_000;
const TIMEOUT_MS = 8_000;
const PAGE_SIZE = 200;
/** 40 pages x 200 = 8,000 opted-in users per read, far under the 50-subrequest Free limit. */
const MAX_PAGES = 40;

export type AppLeadPolicy = {
  policy_type: string;
  insurer: string | null;
  plan_name: string | null;
  start_date: string | null;
  end_date: string | null;
  sum_insured: string | number | null;
  premium: string | number | null;
  renewal_status: string;
  verified: boolean;
};

export type AppLead = {
  app_user_id: string;
  status: "active" | "withdrawn";
  changed_at: string;
  full_name?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  state?: string | null;
  contact_consent_at?: string | null;
  contact_consent_version?: string | null;
  next_renewal_date?: string | null;
  policies?: AppLeadPolicy[];
  withdrawn_at?: string | null;
};

type Page = { items: AppLead[]; next_cursor: string | null; has_more: boolean };

export class AppFeedError extends Error {}

export type AppFeedResult =
  | { state: "ok"; items: AppLead[]; fetchedAt: string }
  | { state: "not-configured" }
  | { state: "error"; message: string };

export type AppLeadsSource = {
  /** Every lead in the feed (active and withdrawn), oldest change first. Never throws. */
  read(force?: boolean): Promise<AppFeedResult>;
};

function config(): { url: string; token: string } | null {
  const url = process.env.APP_API_URL?.trim().replace(/\/+$/, "");
  const token = process.env.APP_LEADS_TOKEN?.trim();
  if (!url || !token) return null;
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(`${url}/`)) return null;
  return { url, token };
}

async function fetchPage(cfg: { url: string; token: string }, cursor: string | null): Promise<Page> {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) query.set("cursor", cursor);
  let response: Response;
  try {
    response = await fetch(`${cfg.url}/partner/leads?${query}`, {
      headers: { "X-Leads-Token": cfg.token, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AppFeedError("The CapitUp app server did not answer. Try again in a minute.");
  }
  if (response.status === 403) throw new AppFeedError("The app server refused the leads token. Check APP_LEADS_TOKEN.");
  if (!response.ok) throw new AppFeedError(`The app server answered ${response.status}.`);
  const body = (await response.json()) as Page;
  if (!Array.isArray(body?.items)) throw new AppFeedError("The app server sent an unexpected reply.");
  return body;
}

let cache: { at: number; result: AppFeedResult } | null = null;

export async function readAppLeads(force = false): Promise<AppFeedResult> {
  const cfg = config();
  if (!cfg) return { state: "not-configured" };
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.result;
  let result: AppFeedResult;
  try {
    const items: AppLead[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await fetchPage(cfg, cursor);
      items.push(...body.items);
      cursor = body.next_cursor;
      if (!body.has_more) break;
    }
    // The feed lists a user again each time they change; keep the latest state per user.
    const latest = new Map<string, AppLead>();
    for (const item of items) latest.set(item.app_user_id, item);
    result = { state: "ok", items: [...latest.values()], fetchedAt: new Date().toISOString() };
  } catch (error) {
    result = { state: "error", message: error instanceof AppFeedError ? error.message : "Could not read the app's leads." };
    console.error("App leads feed failed", { message: error instanceof Error ? error.message : String(error) });
  }
  cache = { at: Date.now(), result };
  return result;
}

export const appLeadsFeed: AppLeadsSource = { read: readAppLeads };

/** Test hook. */
export function resetAppFeedCache(): void {
  cache = null;
}
