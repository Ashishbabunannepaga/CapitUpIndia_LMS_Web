import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AccessDeniedError } from "../errors";
import { officeOverview, refreshOffice } from "../office";
import { readOffice, resetOfficeCache, type OfficeResult, type OfficeSource, type OfficeStats } from "../../office/portal";
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

function fakeSource(result: OfficeResult): OfficeSource & { reads: boolean[] } {
  const reads: boolean[] = [];
  return {
    portalUrl: "https://capitupindia.com/office",
    reads,
    async read(force = false) {
      reads.push(force);
      return result;
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

describe("office portal client", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let sessionValid = true;

  beforeEach(() => {
    resetOfficeCache();
    calls.length = 0;
    sessionValid = true;
    vi.stubEnv("OFFICE_EMAIL", "lms-reader@capitupindia.com");
    vi.stubEnv("OFFICE_PASSWORD", "a-long-office-password");
    vi.stubEnv("OFFICE_PORTAL_URL", "");
    vi.stubEnv("BETTER_AUTH_URL", "https://lms.capitupindia.com");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (url.endsWith("/api/admin/login")) {
          return new Response(JSON.stringify({ user: {}, csrf_token: "x" }), {
            status: 200,
            headers: { "set-cookie": "__Host-capitup-admin=tok123; Path=/; HttpOnly; Secure; SameSite=Strict" },
          });
        }
        const cookie = new Headers(init.headers).get("cookie");
        if (cookie !== "__Host-capitup-admin=tok123" || !sessionValid) {
          sessionValid = true;
          return new Response("{}", { status: 401 });
        }
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
