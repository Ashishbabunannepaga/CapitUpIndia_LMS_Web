import "server-only";

// Reads the capitupindia.com/office console (the Capitup AI site's FastAPI
// backend) on the server. The office has no API keys: it signs in with an
// email and password and hands back an httpOnly session cookie, so this
// module signs in as one read-only office account kept in Worker secrets
// (OFFICE_EMAIL, OFFICE_PASSWORD) and reuses that cookie until it expires.
//
// Free-plan budget: one snapshot (2 subrequests, plus a sign-in when the
// office session has lapsed) per Worker isolate every CACHE_MS. Pages only
// ever read the cached snapshot in between.

export const DEFAULT_OFFICE_URL = "https://capitupindia.com";
const CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 60_000;
/** A forced refresh still waits this long after the last fetch. */
const MIN_REFRESH_MS = 30_000;
const TIMEOUT_MS = 8_000;

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
};

/** One row of /api/admin/renewals: a client policy ending within -30..+90 days. */
export type OfficeRenewal = {
  id: string;
  filename: string;
  policy_type: string | null;
  expires_on: string;
  days_left: number;
  renewal_status: string;
  renewal_note: string;
  title: string | null;
  gaps: Record<string, number> | null;
  contact: { name: string | null; phone: string | null; email: string | null; status: string | null } | null;
};

export type OfficeSnapshot = { fetchedAt: string; stats: OfficeStats; renewals: OfficeRenewal[] };

export type OfficeResult =
  | { status: "ok"; snapshot: OfficeSnapshot }
  | { status: "not-configured" }
  | { status: "error"; message: string };

/** What the data layer needs from the portal; tests pass a fake. */
export type OfficeSource = { portalUrl: string; read(force?: boolean): Promise<OfficeResult> };

type Config = { baseUrl: string; email: string; password: string; origin: string };

function config(): Config | null {
  const email = process.env.OFFICE_EMAIL?.trim();
  const password = process.env.OFFICE_PASSWORD;
  if (!email || !password) return null;
  return {
    baseUrl: officeUrl(),
    email,
    password,
    // The office rejects POSTs whose Origin is not in its ALLOWED_ORIGINS; it
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
  constructor(message: string) {
    super(message);
    this.name = "OfficeError";
  }
}

let cookie: string | null = null;
let cached: { at: number; result: OfficeResult } | null = null;
let inFlight: Promise<OfficeResult> | null = null;

async function call(cfg: Config, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init.headers ?? {}) },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function signIn(cfg: Config): Promise<string> {
  const response = await call(cfg, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: cfg.origin },
    body: JSON.stringify({ email: cfg.email, password: cfg.password }),
  });
  if (response.status === 401) throw new OfficeError("The office portal rejected the LMS account's email or password.");
  if (response.status === 403) throw new OfficeError("The office portal does not allow requests from the LMS yet (its ALLOWED_ORIGINS needs the LMS address).");
  if (response.status === 429) throw new OfficeError("The office portal is rate-limiting sign-ins. Try again in a few minutes.");
  if (!response.ok) throw new OfficeError(`The office portal sign-in failed (HTTP ${response.status}).`);
  const jar = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
  if (!jar) throw new OfficeError("The office portal did not return a session.");
  return jar;
}

async function getJson<T>(cfg: Config, path: string): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    cookie ??= await signIn(cfg);
    const response = await call(cfg, path, { headers: { cookie } });
    if (response.status === 401 && attempt === 0) {
      cookie = null; // idle or expired office session: sign in once more
      continue;
    }
    if (!response.ok) throw new OfficeError(`The office portal answered HTTP ${response.status} for ${path}.`);
    return (await response.json()) as T;
  }
  throw new OfficeError("The office portal session could not be renewed.");
}

async function fetchSnapshot(cfg: Config): Promise<OfficeResult> {
  try {
    const stats = await getJson<OfficeStats>(cfg, "/api/admin/stats");
    const renewals = await getJson<{ items: OfficeRenewal[] }>(cfg, "/api/admin/renewals");
    return { status: "ok", snapshot: { fetchedAt: new Date().toISOString(), stats, renewals: renewals.items ?? [] } };
  } catch (error) {
    const message =
      error instanceof OfficeError ? error.message : "The office portal could not be reached right now.";
    console.error("Office portal read failed", { message: error instanceof Error ? error.message : String(error) });
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

/** The real portal, for pages. */
export const officePortal: OfficeSource = {
  get portalUrl() {
    return `${officeUrl()}/office`;
  },
  read: readOffice,
};

/** Test hook: forget the cookie and cache. */
export function resetOfficeCache(): void {
  cookie = null;
  cached = null;
  inFlight = null;
}
