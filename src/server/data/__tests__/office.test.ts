import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { eq } from "drizzle-orm";

import { AccessDeniedError, InvalidInputError } from "../errors";
import { getLead } from "../leads";
import {
  downloadOfficePolicy,
  getCallRequest,
  getOfficeReport,
  handOffCallRequest,
  leadFromOffice,
  listCallRequests,
  listOfficeGames,
  listOfficePolicies,
  listOfficeRenewals,
  officeOverview,
  refreshOffice,
  updateCallRequest,
  updateOfficeRenewal,
} from "../office";
import { auditLogs } from "../../db/schema";
import {
  OfficeError,
  officeGet,
  officeSend,
  readOffice,
  resetOfficeCache,
  type OfficeResult,
  type OfficeSource,
  type OfficeStats,
} from "../../office/portal";
import { testWorld } from "./helpers";

// The capitupindia.com/office page: everyone gets the link and the counts;
// only admins get the client renewal list (names and phone numbers).

const stats: OfficeStats = {
  policies: { total: 12, week: 3, previous_week: 2, today: 1, by_type: { health: 8, motor: 4 }, by_status: { ready: 12 } },
  reports: 10,
  leads: { total: 5, week: 2, previous_week: 1, today: 0, from_reports: 4, by_status: { new: 3, contacted: 2 }, by_source: { policy: 5 } },
  funnel: { visitors: 40, policies: 12, reports: 10, leads: 5 },
  gaps: { levels: { HIGH: 2, MEDIUM: 3, LOW: 1, OK: 9 }, reports_with_high: 2 },
  games: 7,
  renewals_due: 1,
  daily: [],
};
const renewal = {
  id: "p1",
  filename: "policy.pdf",
  policy_type: "health",
  expires_on: "2026-11-20",
  days_left: 16,
  renewal_status: "to_contact",
  renewal_note: "",
  title: "Family floater",
  gaps: { HIGH: 1, MEDIUM: 0, LOW: 0, OK: 3 },
  contact: { name: "Ravi Client", phone: "+919800000000", email: null, status: "new" },
};

type Call = { method: string; path: string; body?: unknown };

function fakeSource(result: OfficeResult, responses: Record<string, unknown> = {}): OfficeSource & { reads: boolean[]; calls: Call[] } {
  const reads: boolean[] = [];
  const calls: Call[] = [];
  const answer = (path: string) => {
    const key = Object.keys(responses).find((k) => path.startsWith(k));
    if (!key) throw new OfficeError("That item is no longer in the office portal.", 404);
    const value = responses[key];
    return typeof value === "function" ? (value as (p: string) => unknown)(path) : structuredClone(value);
  };
  return {
    portalUrl: "https://capitupindia.com/office",
    reads,
    calls,
    async read(force = false) {
      reads.push(force);
      return result;
    },
    async get<T>(path: string) {
      calls.push({ method: "GET", path });
      return answer(path) as T;
    },
    async send<T>(method: "PATCH" | "POST", path: string, body: unknown) {
      calls.push({ method, path, body });
      return { ...(answer(path) as object), ...(body as object) } as T;
    },
    async download(path: string) {
      calls.push({ method: "GET", path });
      return new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } });
    },
  };
}
const ok: OfficeResult = { status: "ok", snapshot: { fetchedAt: "2026-11-04T08:00:00Z", stats, renewals: [renewal] } };

let w: Awaited<ReturnType<typeof testWorld>>;
beforeAll(async () => {
  w = await testWorld();
});
afterAll(async () => {
  await w?.dispose();
});

describe("office overview access", () => {
  it("gives admins the stats and the client renewal list", async () => {
    const view = await officeOverview(fakeSource(ok), w.admin);
    expect(view.state).toBe("ok");
    expect(view.stats?.policies.total).toBe(12);
    expect(view.renewals).toHaveLength(1);
  });

  it("gives agents the counts but no client names or phone numbers", async () => {
    const view = await officeOverview(fakeSource(ok), w.amit);
    expect(view.stats?.renewals_due).toBe(1);
    expect(view.renewals).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("Ravi Client");
    expect(JSON.stringify(view)).not.toContain("+919800000000");
  });

  it("still links to the portal when it is not configured or fails", async () => {
    const off = await officeOverview(fakeSource({ status: "not-configured" }), w.amit);
    expect(off).toEqual({ portalUrl: "https://capitupindia.com/office", state: "not-configured", message: undefined });
    const down = await officeOverview(fakeSource({ status: "error", message: "Down." }), w.admin);
    expect(down.state).toBe("error");
    expect(down.message).toBe("Down.");
    expect(down.stats).toBeUndefined();
  });

  it("lets only admins force a refresh", async () => {
    const source = fakeSource(ok);
    await expect(refreshOffice(source, w.amit)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(source.reads).toEqual([]);
    await refreshOffice(source, w.admin);
    expect(source.reads).toEqual([true]);
  });
});

// --- Working the office inside the LMS (admins), handing clients to agents ---

const LEAD_ID = "11111111-2222-4333-8444-555555555555";
const CONV_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const POLICY_ID = "99999999-8888-4777-8666-555555555555";

const officeLead = {
  id: LEAD_ID,
  name: "Ravi Client",
  email: "ravi@example.com",
  phone: "+91 98000 00000",
  message: "Is my family floater enough?",
  preferred_time: "Evening",
  timezone: "Asia/Kolkata",
  source: "policy",
  conversation_id: CONV_ID,
  game_result_id: null,
  marketing_opt_in: false,
  ip: "203.0.113.9",
  visitor_id: "visitor-secret",
  status: "new",
  notes: "",
  handled_by: null,
  status_changed_at: null,
  created_at: "2026-11-01T10:00:00+00:00",
};
const officePolicy = {
  id: POLICY_ID,
  conversation_id: CONV_ID,
  filename: "family-floater.pdf",
  content_type: "application/pdf",
  status: "extracted",
  pages: 12,
  policy_type: "health",
  extraction_method: "text",
  ocr_pages: 0,
  ocr_confidence: null,
  expires_on: "2026-12-15",
  renewal_status: "to_contact",
  created_at: "2026-11-01T09:50:00+00:00",
  report_at: "2026-11-01T09:55:00+00:00",
  gaps: { HIGH: 2, MEDIUM: 1, LOW: 0, OK: 5 },
};
const client = { lead: officeLead, policies: [officePolicy], other_requests: [], games: [] };
const conversation = {
  id: CONV_ID,
  status: "open",
  policy: officePolicy,
  ip: "203.0.113.9",
  messages: [
    { id: "m1", role: "user", content: "Here is my policy, my PAN is ABCDE1234F", created_at: "2026-11-01T09:51:00+00:00" },
    { id: "m2", role: "assistant", content: "# Your gap report\n\n| HIGH | Room rent cap |\n|---|---|\n\n```summary\n{\"verdict\":\"x\"}\n```", created_at: "2026-11-01T09:55:00+00:00" },
    { id: "m3", role: "assistant", content: "Thanks, we will call you.", created_at: "2026-11-01T09:56:00+00:00" },
  ],
  consents: [{ id: "c1", purpose: "policy_analysis", accepted: true, marketing: false, ip: "203.0.113.9", created_at: "2026-11-01T09:50:00+00:00" }],
};
const responses = {
  "/api/admin/leads?": { items: [officeLead], next_cursor: null },
  [`/api/admin/clients/${LEAD_ID}`]: client,
  [`/api/admin/leads/${LEAD_ID}`]: officeLead,
  [`/api/admin/conversations/${CONV_ID}`]: conversation,
  [`/api/admin/policies/${POLICY_ID}/renewal`]: officePolicy,
  "/api/admin/policies?": { items: [{ ...officePolicy, ip: "203.0.113.9" }], next_cursor: null },
  "/api/admin/game-results?": { items: [], next_cursor: null },
};

describe("office work is for admins only", () => {
  it("refuses every client-level office read and write to agents, without calling the portal", async () => {
    const source = fakeSource(ok, responses);
    const attempts = [
      () => listCallRequests(source, w.ctx, w.amit),
      () => getCallRequest(source, w.ctx, w.amit, LEAD_ID),
      () => updateCallRequest(source, w.ctx, w.amit, LEAD_ID, { status: "contacted" }),
      () => handOffCallRequest(source, w.ctx, w.amit, LEAD_ID, w.amit.id),
      () => listOfficeRenewals(source, w.amit),
      () => updateOfficeRenewal(source, w.ctx, w.amit, POLICY_ID, { renewal_status: "quoted" }),
      () => listOfficePolicies(source, w.amit),
      () => getOfficeReport(source, w.amit, CONV_ID),
      () => listOfficeGames(source, w.amit),
      () => downloadOfficePolicy(source, w.ctx, w.amit, POLICY_ID),
    ];
    for (const run of attempts) await expect(run()).rejects.toBeInstanceOf(AccessDeniedError);
    expect(source.calls).toEqual([]);
  });

  it("keeps the latest call requests' names out of an agent's overview", async () => {
    const withNames: OfficeResult = { status: "ok", snapshot: { ...ok.snapshot, stats: { ...stats, recent_leads: [officeLead] } } };
    const agentView = await officeOverview(fakeSource(withNames), w.amit);
    expect(agentView.stats?.recent_leads).toBeUndefined();
    expect(JSON.stringify(agentView)).not.toContain("Ravi Client");
    const adminView = await officeOverview(fakeSource(withNames), w.admin);
    expect(adminView.stats?.recent_leads?.[0].name).toBe("Ravi Client");
    expect(JSON.stringify(adminView)).not.toContain("203.0.113.9");
  });
});

describe("call requests in the LMS", () => {
  it("lists call requests without the visitor's IP address or session id", async () => {
    const page = await listCallRequests(fakeSource(ok, responses), w.ctx, w.admin);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].name).toBe("Ravi Client");
    expect(JSON.stringify(page)).not.toContain("203.0.113.9");
    expect(JSON.stringify(page)).not.toContain("visitor-secret");
    expect(page.handoffs).toEqual({});
  });

  it("rejects ids and cursors that could reach another office endpoint", async () => {
    const source = fakeSource(ok, responses);
    await expect(getCallRequest(source, w.ctx, w.admin, "../users")).rejects.toBeInstanceOf(InvalidInputError);
    await expect(updateCallRequest(source, w.ctx, w.admin, `${LEAD_ID}/x`, { status: "new" })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(listCallRequests(source, w.ctx, w.admin, "a&limit=1000")).rejects.toBeInstanceOf(InvalidInputError);
    expect(source.calls).toEqual([]);
  });

  it("saves follow-up status and notes in the office and audits who did it", async () => {
    const source = fakeSource(ok, responses);
    await expect(updateCallRequest(source, w.ctx, w.admin, LEAD_ID, { status: "won" })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(updateCallRequest(source, w.ctx, w.admin, LEAD_ID, {})).rejects.toBeInstanceOf(InvalidInputError);
    await expect(updateCallRequest(source, w.ctx, w.admin, LEAD_ID, { notes: "x".repeat(4001) })).rejects.toBeInstanceOf(InvalidInputError);
    expect(source.calls).toEqual([]);

    const updated = await updateCallRequest(source, w.ctx, w.admin, LEAD_ID, { status: "contacted", notes: "Called, sending quotes" });
    expect(updated.status).toBe("contacted");
    expect(source.calls).toEqual([
      { method: "PATCH", path: `/api/admin/leads/${LEAD_ID}`, body: { status: "contacted", notes: "Called, sending quotes" } },
    ]);
    const audit = await w.ctx.db.select().from(auditLogs).where(eq(auditLogs.table_name, "office_call_requests"));
    expect(audit.at(-1)).toMatchObject({ record_id: LEAD_ID, actor_id: w.admin.id, action: "UPDATE" });
  });

  it("shows only the gap report from a conversation, without the summary block or the client's chat", async () => {
    const report = await getOfficeReport(fakeSource(ok, responses), w.admin, CONV_ID);
    expect(report.report?.content).toContain("# Your gap report");
    expect(report.report?.content).not.toContain("```summary");
    expect(JSON.stringify(report)).not.toContain("ABCDE1234F");
    expect(JSON.stringify(report)).not.toContain("203.0.113.9");
    expect(report.consents).toEqual([{ purpose: "policy_analysis", accepted: true, marketing: false, created_at: "2026-11-01T09:50:00+00:00" }]);
  });

  it("maps an office client to a Retail renewal lead with the next policy end date", () => {
    const fields = leadFromOffice(client as never, "2026-11-04");
    expect(fields).toMatchObject({
      client_name: "Ravi Client",
      type: "Renewal",
      business_type: "Retail",
      policy_product: "Health",
      renewal_date: "2026-12-15",
      poc_name: "Ravi Client",
      poc_contact_number: "+91 98000 00000",
      poc_email_id: "ravi@example.com",
      status: "Prospect",
    });
    expect(fields.notes).toContain("Is my family floater enough?");
    expect(fields.notes).toContain("2 high, 1 medium");
    expect(fields.notes).toContain("no marketing");
    const noPolicy = leadFromOffice({ lead: { ...officeLead, email: "not-an-email" }, policies: [] } as never);
    expect(noPolicy).toMatchObject({ type: "New", renewal_date: null, poc_email_id: "" });
  });

  it("hands a call request to an agent once: the agent sees it in their leads, the office gets a note", async () => {
    const source = fakeSource(ok, responses);
    await expect(handOffCallRequest(source, w.ctx, w.admin, LEAD_ID, "not-a-user")).rejects.toBeInstanceOf(InvalidInputError);

    const result = await handOffCallRequest(source, w.ctx, w.admin, LEAD_ID, w.amit.id);
    expect(result.officeNoted).toBe(true);
    const lead = await getLead(w.ctx, w.amit, result.leadId);
    expect(lead).toMatchObject({ client_name: "Ravi Client", assigned_agent_id: w.amit.id, office_lead_id: LEAD_ID, renewal_date: "2026-12-15" });
    expect(await getLead(w.ctx, w.neha, result.leadId)).toBeNull();

    const note = source.calls.find((c) => c.method === "PATCH");
    expect(note?.path).toBe(`/api/admin/leads/${LEAD_ID}`);
    expect(String((note?.body as { notes: string }).notes)).toContain(`Handed to Amit Agent as LMS lead #${result.leadId}`);

    const page = await listCallRequests(source, w.ctx, w.admin);
    expect(page.handoffs[LEAD_ID]).toEqual({ leadId: result.leadId, agentName: "Amit Agent" });
    await expect(handOffCallRequest(source, w.ctx, w.admin, LEAD_ID, w.neha.id)).rejects.toThrow(/already LMS lead/);
  });
});

describe("office renewals and files in the LMS", () => {
  it("validates renewal changes before writing them to the office", async () => {
    const source = fakeSource(ok, responses);
    await expect(updateOfficeRenewal(source, w.ctx, w.admin, POLICY_ID, { renewal_status: "maybe" })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(updateOfficeRenewal(source, w.ctx, w.admin, POLICY_ID, { expires_on: "15/12/2026" })).rejects.toBeInstanceOf(InvalidInputError);
    expect(source.calls).toEqual([]);
    await updateOfficeRenewal(source, w.ctx, w.admin, POLICY_ID, { renewal_status: "quoted", expires_on: "2026-12-20" });
    expect(source.calls).toEqual([
      { method: "PATCH", path: `/api/admin/policies/${POLICY_ID}/renewal`, body: { renewal_status: "quoted", expires_on: "2026-12-20" } },
    ]);
  });

  it("lists policies without the visitor's IP address", async () => {
    const page = await listOfficePolicies(fakeSource(ok, responses), w.admin);
    expect(page.items[0].filename).toBe("family-floater.pdf");
    expect(JSON.stringify(page)).not.toContain("203.0.113.9");
  });

  it("streams a policy file to admins and audits the download", async () => {
    const file = await downloadOfficePolicy(fakeSource(ok, responses), w.ctx, w.admin, POLICY_ID);
    expect(await file.text()).toBe("%PDF-1.4");
    const audit = await w.ctx.db.select().from(auditLogs).where(eq(auditLogs.table_name, "office_policy_downloads"));
    expect(audit.at(-1)).toMatchObject({ record_id: POLICY_ID, actor_id: w.admin.id });
  });

  it("turns office failures into plain messages", async () => {
    const source = fakeSource(ok, {});
    await expect(getCallRequest(source, w.ctx, w.admin, LEAD_ID)).rejects.toThrow("That item is no longer in the office portal.");
    await expect(listOfficeRenewals(fakeSource({ status: "error", message: "Down." }), w.admin)).rejects.toThrow("Down.");
  });
});

describe("office portal client", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let sessionValid = true;
  let csrf = "csrf-1";

  beforeEach(() => {
    resetOfficeCache();
    calls.length = 0;
    sessionValid = true;
    csrf = "csrf-1";
    vi.stubEnv("OFFICE_EMAIL", "lms-reader@capitupindia.com");
    vi.stubEnv("OFFICE_PASSWORD", "a-long-office-password");
    vi.stubEnv("OFFICE_PORTAL_URL", "");
    vi.stubEnv("BETTER_AUTH_URL", "https://lms.capitupindia.com");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (url.endsWith("/api/admin/login")) {
          return new Response(JSON.stringify({ user: {}, csrf_token: csrf }), {
            status: 200,
            headers: { "set-cookie": "__Host-capitup-admin=tok123; Path=/; HttpOnly; Secure; SameSite=Strict" },
          });
        }
        const cookie = new Headers(init.headers).get("cookie");
        if (cookie !== "__Host-capitup-admin=tok123" || !sessionValid) {
          sessionValid = true;
          return new Response("{}", { status: 401 });
        }
        if (init.method === "PATCH") {
          const headers = new Headers(init.headers);
          if (headers.get("origin") !== "https://lms.capitupindia.com") return Response.json({ detail: "Request origin is not allowed." }, { status: 403 });
          if (headers.get("x-csrf-token") !== csrf) return Response.json({ detail: "Refresh this page and try again." }, { status: 403 });
          return Response.json({ ...JSON.parse(String(init.body)), id: "lead-1" });
        }
        if (url.includes("/api/admin/leads?")) return Response.json({ items: [], next_cursor: null });
        if (url.endsWith("/api/admin/stats")) return Response.json(stats);
        if (url.endsWith("/api/admin/renewals")) return Response.json({ today: "2026-11-04", items: [renewal] });
        return new Response("{}", { status: 404 });
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is off without the office secrets", async () => {
    vi.stubEnv("OFFICE_PASSWORD", "");
    expect(await readOffice()).toEqual({ status: "not-configured" });
    expect(calls).toHaveLength(0);
  });

  it("signs in once with the LMS origin, then reads stats and renewals", async () => {
    const result = await readOffice();
    expect(result.status).toBe("ok");
    expect(calls.map((c) => c.url)).toEqual([
      "https://capitupindia.com/api/admin/login",
      "https://capitupindia.com/api/admin/stats",
      "https://capitupindia.com/api/admin/renewals",
    ]);
    const login = calls[0].init;
    expect(new Headers(login.headers).get("origin")).toBe("https://lms.capitupindia.com");
    expect(JSON.parse(String(login.body))).toEqual({ email: "lms-reader@capitupindia.com", password: "a-long-office-password" });
  });

  it("serves the cached snapshot instead of calling the portal again", async () => {
    await readOffice();
    await readOffice();
    await readOffice(true); // a forced refresh within 30 seconds is still cached
    expect(calls).toHaveLength(3);
  });

  it("signs in again when the office session has expired", async () => {
    await readOffice();
    sessionValid = false;
    resetCacheOnly();
    const result = await readOffice();
    expect(result.status).toBe("ok");
    expect(calls.filter((c) => c.url.endsWith("/login"))).toHaveLength(1 + 1);
  });

  it("reports a wrong office password without leaking it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const result = await readOffice();
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("a-long-office-password");
  });

  it("writes with the office CSRF token and the LMS origin", async () => {
    await officeSend("PATCH", "/api/admin/leads/lead-1", { status: "contacted" });
    const patch = calls.find((c) => c.init.method === "PATCH")!;
    expect(new Headers(patch.init.headers).get("x-csrf-token")).toBe("csrf-1");
    expect(JSON.parse(String(patch.init.body))).toEqual({ status: "contacted" });
  });

  it("signs in again when a write's CSRF token is stale", async () => {
    await officeGet("/api/admin/leads?limit=100");
    csrf = "csrf-2"; // the office session changed underneath the LMS
    await officeSend("PATCH", "/api/admin/leads/lead-1", { notes: "x" });
    expect(calls.filter((c) => c.url.endsWith("/login"))).toHaveLength(2);
    expect(new Headers(calls.at(-1)!.init.headers).get("x-csrf-token")).toBe("csrf-2");
  });

  it("caches reads for a minute and drops the cache after a write", async () => {
    await officeGet("/api/admin/leads?limit=100");
    await officeGet("/api/admin/leads?limit=100");
    expect(calls.filter((c) => c.url.includes("/leads?"))).toHaveLength(1);
    await officeSend("PATCH", "/api/admin/leads/lead-1", { notes: "x" });
    await officeGet("/api/admin/leads?limit=100");
    expect(calls.filter((c) => c.url.includes("/leads?"))).toHaveLength(2);
  });

  it("explains that the portal is not connected instead of calling it", async () => {
    vi.stubEnv("OFFICE_EMAIL", "");
    await expect(officeGet("/api/admin/leads?limit=100")).rejects.toThrow(/not connected/);
    expect(calls).toHaveLength(0);
  });

  it("never sends the office password over plain http", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("OFFICE_PORTAL_URL", "http://capitupindia.com");
    await readOffice();
    expect(calls.every((c) => c.url.startsWith("https://capitupindia.com/"))).toBe(true);
  });
});

// Expire only the snapshot, keeping the stored office cookie.
function resetCacheOnly() {
  vi.useFakeTimers({ now: Date.now() + 10 * 60_000, toFake: ["Date"] });
}
