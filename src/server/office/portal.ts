import "server-only";

// The capitupindia.com/office console (the Capitup AI site's FastAPI backend)
// as seen from the LMS server. The public site keeps its own data (visitors,
// policy uploads, gap reports, call requests) in its own database; the LMS
// works on that data through the office's admin API, signed in as one office
// account kept in Worker secrets (OFFICE_EMAIL, OFFICE_PASSWORD).
//
// The office has no API keys: POST /api/admin/login returns an httpOnly
// session cookie plus a CSRF token, and every PATCH/POST must carry that token
// (X-CSRF-Token) and an Origin listed in the office's ALLOWED_ORIGINS.
//
// Free-plan budget: the overview snapshot (stats + renewals, 2 subrequests) is
// cached per Worker isolate for CACHE_MS; other reads for READ_CACHE_MS. A
// page view makes at most a few subrequests, far under the Free limit of 50.

export const DEFAULT_OFFICE_URL = "https://capitupindia.com";
const CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 60_000;
/** A forced refresh still waits this long after the last fetch. */
const MIN_REFRESH_MS = 30_000;
const READ_CACHE_MS = 60_000;
const READ_CACHE_MAX = 100;
const TIMEOUT_MS = 8_000;
const DOWNLOAD_TIMEOUT_MS = 25_000;

export type GapCounts = { HIGH: number; MEDIUM: number; LOW: number; OK: number };

/** A call request (office "lead"): someone on capitupindia.com asking to be called. */
export type OfficeLead = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  message: string;
  preferred_time: string | null;
  timezone: string | null;
  source: string;
  conversation_id: string | null;
  marketing_opt_in: boolean;
  status: string;
  notes: string;
  handled_by: string | null;
  status_changed_at: string | null;
  created_at: string;
};

/** /api/admin/stats, the fields the LMS shows. */
export type OfficeStats = {
  policies: { total: number; week: number; previous_week: number; today: number; by_type: Record<string, number>; by_status: Record<string, number> };
  reports: number;
  leads: { total: number; week: number; previous_week: number; today: number; from_reports: number; by_status: Record<string, number>; by_source: Record<string, number> };
  funnel: { visitors: number; policies: number; reports: number; leads: number };
  gaps: { levels: Record<string, number>; reports_with_high: number };
  games: number;
  renewals_due: number;
  daily: { day: string; uploads: number; leads: number }[];
  /** Names and phone numbers: admins only (the data layer strips it for agents). */
  recent_leads?: OfficeLead[];
};

/** One row of /api/admin/renewals: a client policy ending within -30..+90 days. */
export type OfficeRenewal = {
  id: string;
  filename: string;
  policy_type: string | null;
  expires_on: string;
  expiry_source?: string | null;
  days_left: number;
  renewal_status: string;
  renewal_note: string;
  renewal_updated_by?: string | null;
  renewal_updated_at?: string | null;
  title: string | null;
  gaps: GapCounts | null;
  contact: {
    id?: string;
    name: string | null;
    phone: string | null;
    email: string | null;
    marketing_opt_in?: boolean;
    status: string | null;
    conversation_id?: string | null;
  } | null;
};

/** An uploaded policy, without its text or storage key. */
export type OfficePolicy = {
  id: string;
  conversation_id: string;
  filename: string;
  content_type: string;
  status: string;
  message?: string;
  pages: number;
  policy_type: string | null;
  extraction_method: string | null;
  ocr_pages: number;
  ocr_confidence: number | null;
  expires_on?: string | null;
  renewal_status?: string;
  created_at: string;
  report_at?: string | null;
  gaps?: GapCounts | null;
};

export type OfficeGame = {
  id: string;
  answers: Record<string, unknown>;
  result: Record<string, unknown>;
  version: string;
  created_at: string;
};

export type OfficeConsent = { purpose: string; accepted: boolean; marketing: boolean; created_at: string };

export type OfficeConversation = {
  id: string;
  status: string;
  policy: OfficePolicy | null;
  messages: { id: string; role: string; content: string; created_at: string }[];
  consents?: OfficeConsent[];
};

export type OfficeClient = {
  lead: OfficeLead;
  policies: OfficePolicy[];
  other_requests: OfficeLead[];
  games: OfficeGame[];
};

export type OfficePage<T> = { items: T[]; next_cursor: string | null };

export type OfficeSnapshot = { fetchedAt: string; stats: OfficeStats; renewals: OfficeRenewal[] };

export type OfficeResult =
  | { status: "ok"; snapshot: OfficeSnapshot }
  | { status: "not-configured" }
  | { status: "error"; message: string };

/** What the data layer needs from the portal; tests pass a fake. */
export type OfficeSource = {
  portalUrl: string;
  /** The cached overview (stats and renewals). */
  read(force?: boolean): Promise<OfficeResult>;
  /** A JSON read; throws OfficeError. */
  get<T>(path: string): Promise<T>;
  /** A JSON write; throws OfficeError. Clears the read caches. */
  send<T>(method: "PATCH" | "POST", path: string, body: unknown): Promise<T>;
  /** A file download, streamed as the office sends it; throws OfficeError. */
  download(path: string): Promise<Response>;
};

type Config = { baseUrl: string; email: string; password: string; origin: string };

function config(): Config | null {
  const email = process.env.OFFICE_EMAIL?.trim();
  const password = process.env.OFFICE_PASSWORD;
  if (!email || !password) return null;
  return {
    baseUrl: officeUrl(),
    email,
    password,
    // The office rejects writes whose Origin is not in its ALLOWED_ORIGINS; it
    // must list the LMS address (https://lms.capitupindia.com).
    origin: new URL(process.env.BETTER_AUTH_URL || "http://localhost:3000").origin,
  };
}

/** The office site's origin. Anything but an https address falls back to the default. */
export function officeUrl(): string {
  const raw = process.env.OFFICE_PORTAL_URL?.trim();
  if (!raw) return DEFAULT_OFFICE_URL;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return url.origin;
  } catch {
    // fall through
  }
  console.error("OFFICE_PORTAL_URL is not an https address; using the default.");
  return DEFAULT_OFFICE_URL;
}

export class OfficeError extends Error {
  /** HTTP status from the office, or 0 when it was not reached / not configured. */
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "OfficeError";
    this.status = status;
  }
}

export const NOT_CONFIGURED =
  "The office portal is not connected yet: an admin adds the Worker secrets OFFICE_EMAIL and OFFICE_PASSWORD.";

let session: { cookie: string; csrf: string } | null = null;
let cached: { at: number; result: OfficeResult } | null = null;
let inFlight: Promise<OfficeResult> | null = null;
const reads = new Map<string, { at: number; value: unknown }>();

async function call(cfg: Config, path: string, init: RequestInit = {}, timeout = TIMEOUT_MS): Promise<Response> {
  return fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init.headers ?? {}) },
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  });
}

async function signIn(cfg: Config): Promise<{ cookie: string; csrf: string }> {
  const response = await call(cfg, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: cfg.origin },
    body: JSON.stringify({ email: cfg.email, password: cfg.password }),
  });
  if (response.status === 401) throw new OfficeError("The office portal rejected the LMS account's email or password.", 401);
  if (response.status === 403) throw new OfficeError("The office portal does not allow requests from the LMS yet (its ALLOWED_ORIGINS needs the LMS address).", 403);
  if (response.status === 429) throw new OfficeError("The office portal is rate-limiting sign-ins. Try again in a few minutes.", 429);
  if (!response.ok) throw new OfficeError(`The office portal sign-in failed (HTTP ${response.status}).`, response.status);
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
  if (!cookie) throw new OfficeError("The office portal did not return a session.");
  let csrf = "";
  try {
    const body = (await response.json()) as { csrf_token?: unknown };
    if (typeof body.csrf_token === "string") csrf = body.csrf_token;
  } catch {
    // reads still work without it; writes will fail with a clear message
  }
  return { cookie, csrf };
}

/** The office's own error text when it is short and plain; never echoes request data. */
async function officeMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail.length <= 200) return body.detail;
  } catch {
    // not JSON
  }
  return null;
}

async function authorized(cfg: Config, path: string, init: RequestInit, timeout?: number): Promise<Response> {
  const write = init.method !== undefined && init.method !== "GET";
  for (let attempt = 0; attempt < 2; attempt++) {
    session ??= await signIn(cfg);
    const headers: Record<string, string> = { cookie: session.cookie };
    if (write) {
      headers.origin = cfg.origin;
      headers["x-csrf-token"] = session.csrf;
      headers["content-type"] = "application/json";
    }
    const response = await call(cfg, path, { ...init, headers }, timeout);
    // Idle or expired office session (401), or a CSRF token from an older
    // session (403 on a write): sign in once more.
    if (attempt === 0 && (response.status === 401 || (write && response.status === 403))) {
      session = null;
      continue;
    }
    return response;
  }
  throw new OfficeError("The office portal session could not be renewed.");
}

async function json<T>(cfg: Config, path: string, init: RequestInit = {}): Promise<T> {
  const response = await authorized(cfg, path, init);
  if (!response.ok) {
    const detail = await officeMessage(response);
    if (response.status === 404) throw new OfficeError(detail ?? "That item is no longer in the office portal.", 404);
    if (response.status === 403) throw new OfficeError(detail ?? "The office portal refused this change.", 403);
    if (response.status === 409 || response.status === 422) throw new OfficeError(detail ?? "The office portal did not accept that change.", response.status);
    throw new OfficeError(`The office portal answered HTTP ${response.status}.`, response.status);
  }
  return (await response.json()) as T;
}

function failure(error: unknown): string {
  if (error instanceof OfficeError) return error.message;
  console.error("Office portal call failed", { message: error instanceof Error ? error.message : String(error) });
  return "The office portal could not be reached right now.";
}

async function fetchSnapshot(cfg: Config): Promise<OfficeResult> {
  try {
    const stats = await json<OfficeStats>(cfg, "/api/admin/stats");
    const renewals = await json<{ items: OfficeRenewal[] }>(cfg, "/api/admin/renewals");
    return { status: "ok", snapshot: { fetchedAt: new Date().toISOString(), stats, renewals: renewals.items ?? [] } };
  } catch (error) {
    const message = failure(error);
    console.error("Office portal read failed", { message });
    return { status: "error", message };
  }
}

/** The cached office snapshot; refetched after CACHE_MS, or now when `force`. */
export async function readOffice(force = false): Promise<OfficeResult> {
  const cfg = config();
  if (!cfg) return { status: "not-configured" };
  const now = Date.now();
  if (cached) {
    const ttl = force ? MIN_REFRESH_MS : cached.result.status === "ok" ? CACHE_MS : FAILURE_CACHE_MS;
    if (now - cached.at < ttl) return cached.result;
  }
  // Concurrent page loads in one isolate share a single fetch.
  inFlight ??= fetchSnapshot(cfg).then((result) => {
    cached = { at: Date.now(), result };
    inFlight = null;
    return result;
  });
  return inFlight;
}

function required(): Config {
  const cfg = config();
  if (!cfg) throw new OfficeError(NOT_CONFIGURED);
  return cfg;
}

function wrap(error: unknown): never {
  if (error instanceof OfficeError) throw error;
  throw new OfficeError(failure(error));
}

/** A JSON read, cached for a minute per isolate. */
export async function officeGet<T>(path: string): Promise<T> {
  const cfg = required();
  const hit = reads.get(path);
  if (hit && Date.now() - hit.at < READ_CACHE_MS) return hit.value as T;
  try {
    const value = await json<T>(cfg, path);
    if (reads.size >= READ_CACHE_MAX) reads.delete(reads.keys().next().value as string);
    reads.set(path, { at: Date.now(), value });
    return value;
  } catch (error) {
    wrap(error);
  }
}

/** A JSON write. Every cached read may now be stale, so they are all dropped. */
export async function officeSend<T>(method: "PATCH" | "POST", path: string, body: unknown): Promise<T> {
  const cfg = required();
  try {
    return await json<T>(cfg, path, { method, body: JSON.stringify(body) });
  } catch (error) {
    wrap(error);
  } finally {
    reads.clear();
    cached = null;
  }
}

/** A file from the office, passed through without buffering it in the Worker. */
export async function officeDownload(path: string): Promise<Response> {
  const cfg = required();
  let response: Response;
  try {
    response = await authorized(cfg, path, {}, DOWNLOAD_TIMEOUT_MS);
  } catch (error) {
    wrap(error);
  }
  if (response.status === 404) throw new OfficeError("The stored file is no longer available.", 404);
  if (!response.ok || !response.body) throw new OfficeError(`The office portal answered HTTP ${response.status}.`, response.status);
  return response;
}

/** The real portal, for pages. */
export const officePortal: OfficeSource = {
  get portalUrl() {
    return `${officeUrl()}/office`;
  },
  read: readOffice,
  get: officeGet,
  send: officeSend,
  download: officeDownload,
};

/** Test hook: forget the session and caches. */
export function resetOfficeCache(): void {
  session = null;
  cached = null;
  inFlight = null;
  reads.clear();
}
