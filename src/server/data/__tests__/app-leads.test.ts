import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { eq } from "drizzle-orm";

import { leads } from "../../db/schema";
import type { AppFeedResult, AppLead, AppLeadsSource } from "../../appfeed/feed";
import { readAppLeads, resetAppFeedCache } from "../../appfeed/feed";
import { WITHDRAWN_MARKER, handOffAppLead, leadFromApp, listAppLeads, syncAppWithdrawals } from "../app-leads";
import { AccessDeniedError, InvalidInputError } from "../errors";
import { testWorld } from "./helpers";

// Leads from the CapitUp client app: only people who opted in to be contacted,
// admins only, one LMS lead per app user, and withdrawals stop the calling.

const RAVI = "11111111-2222-4333-8444-555555555555";
const SITA = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const ravi: AppLead = {
  app_user_id: RAVI,
  status: "active",
  changed_at: "2026-11-10T10:00:00Z",
  full_name: "Ravi Kumar",
  phone: "+919876500002",
  email: "ravi@example.com",
  city: "Hyderabad",
  state: "Telangana",
  contact_consent_at: "2026-11-10T09:00:00Z",
  contact_consent_version: "2026-11-10",
  next_renewal_date: "2026-12-20",
  policies: [
    { policy_type: "motor", insurer: "ICICI Lombard", plan_name: "Car Secure", start_date: "2025-12-21", end_date: "2026-12-20", sum_insured: null, premium: "8400.00", renewal_status: "pending", verified: true },
    { policy_type: "health", insurer: "Niva Bupa", plan_name: "ReAssure", start_date: "2026-03-01", end_date: "2027-02-28", sum_insured: "500000", premium: null, renewal_status: "pending", verified: false },
  ],
};
const sita: AppLead = { ...ravi, app_user_id: SITA, full_name: "Sita", phone: "+919876500003", next_renewal_date: null, policies: [] };

function source(items: AppLead[]): AppLeadsSource & { items: AppLead[] } {
  const s = {
    items,
    async read(): Promise<AppFeedResult> {
      return { state: "ok", items: s.items, fetchedAt: "2026-11-10T10:00:00Z" };
    },
  };
  return s;
}

let world: Awaited<ReturnType<typeof testWorld>>;
beforeAll(async () => {
  world = await testWorld();
});
afterAll(async () => world.dispose());

describe("leadFromApp", () => {
  it("makes a Retail renewal lead from the next policy to end, without policy numbers", () => {
    const lead = leadFromApp(ravi, "2026-11-10");
    expect(lead).toMatchObject({
      client_name: "Ravi Kumar",
      type: "Renewal",
      business_type: "Retail",
      policy_product: "Motor",
      renewal_date: "2026-12-20",
      poc_contact_number: "+919876500002",
      poc_email_id: "ravi@example.com",
      status: "Prospect",
    });
    expect(lead.notes).toContain("opted in to be contacted on 2026-11-10");
    expect(lead.notes).toContain("ICICI Lombard, Car Secure, ends 2026-12-20");
    expect(lead.notes).toContain("(not yet checked by the client)");
  });

  it("is a New lead when the app user has no policies yet", () => {
    expect(leadFromApp(sita)).toMatchObject({ type: "New", renewal_date: null, policy_product: "Not Specified" });
  });
});

describe("app leads", () => {
  it("are for admins only", async () => {
    const feed = source([ravi]);
    await expect(listAppLeads(feed, world.ctx, world.amit)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(handOffAppLead(feed, world.ctx, world.amit, RAVI, null)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("are listed for admins, and handed over once to an agent", async () => {
    const feed = source([ravi, sita]);
    const before = await listAppLeads(feed, world.ctx, world.admin);
    expect(before.state === "ok" && before.items.map((i) => [i.app_user_id, i.handoff])).toEqual([
      [RAVI, null],
      [SITA, null],
    ]);

    const { leadId } = await handOffAppLead(feed, world.ctx, world.admin, RAVI.toUpperCase(), world.amit.id);
    const row = await world.ctx.db.query.leads.findFirst({ where: eq(leads.id, leadId) });
    expect(row).toMatchObject({ app_user_id: RAVI, assigned_agent_id: world.amit.id, business_type: "Retail" });

    await expect(handOffAppLead(feed, world.ctx, world.admin, RAVI, null)).rejects.toThrow(`already LMS lead #${leadId}`);
    const after = await listAppLeads(feed, world.ctx, world.admin);
    // Not yet handed over comes first.
    expect(after.state === "ok" && after.items.map((i) => [i.app_user_id, i.handoff?.leadId ?? null])).toEqual([
      [SITA, null],
      [RAVI, leadId],
    ]);
  });

  it("refuses bad ids, inactive people and people no longer opted in", async () => {
    const feed = source([{ ...sita, status: "withdrawn", full_name: null, phone: null }]);
    await expect(handOffAppLead(feed, world.ctx, world.admin, "not-an-id", null)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(handOffAppLead(feed, world.ctx, world.admin, SITA, null)).rejects.toThrow("no longer opted in");
  });

  it("stop the calling when the app user withdraws: note, Closed Lost, once", async () => {
    const feed = source([ravi]);
    const lead = await world.ctx.db.query.leads.findFirst({ where: eq(leads.app_user_id, RAVI) });
    feed.items = [{ app_user_id: RAVI, status: "withdrawn", changed_at: "2026-11-11T08:00:00Z", withdrawn_at: "2026-11-11T08:00:00Z" }];

    expect(await syncAppWithdrawals(feed, world.ctx)).toBe(1);
    const row = await world.ctx.db.query.leads.findFirst({ where: eq(leads.id, lead!.id) });
    expect(row!.status).toBe("Closed Lost");
    expect(row!.notes.startsWith(`${WITHDRAWN_MARKER} the client withdrew consent in the CapitUp app on 2026-11-11`)).toBe(true);
    expect(await syncAppWithdrawals(feed, world.ctx)).toBe(0); // idempotent

    const view = await listAppLeads(feed, world.ctx, world.admin);
    expect(view.state === "ok" && view.items).toEqual([]);
    expect(view.state === "ok" && view.withdrawn).toBe(1);
  });

  it("pass through feed problems as a state, not a crash", async () => {
    const down: AppLeadsSource = { read: async () => ({ state: "error", message: "The CapitUp app server did not answer." }) };
    expect(await listAppLeads(down, world.ctx, world.admin)).toEqual({ state: "error", message: "The CapitUp app server did not answer." });
    await expect(handOffAppLead(down, world.ctx, world.admin, SITA, null)).rejects.toThrow("did not answer");
  });
});

describe("the feed client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetAppFeedCache();
  });

  it("is off until both settings exist", async () => {
    vi.stubEnv("APP_API_URL", "");
    vi.stubEnv("APP_LEADS_TOKEN", "");
    expect(await readAppLeads(true)).toEqual({ state: "not-configured" });
  });

  it("pages through the feed with the token and keeps the latest state per user", async () => {
    vi.stubEnv("APP_API_URL", "https://api.capitup.test/api/v1/");
    vi.stubEnv("APP_LEADS_TOKEN", "t".repeat(40));
    const calls: { url: string; token: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, token: new Headers(init.headers).get("X-Leads-Token") });
      const second = url.includes("cursor=");
      return Response.json(
        second
          ? { items: [{ ...ravi, status: "withdrawn" }], next_cursor: "c2", has_more: false }
          : { items: [ravi, sita], next_cursor: "c1", has_more: true },
      );
    });
    const result = await readAppLeads(true);
    expect(calls).toEqual([
      { url: "https://api.capitup.test/api/v1/partner/leads?limit=200", token: "t".repeat(40) },
      { url: "https://api.capitup.test/api/v1/partner/leads?limit=200&cursor=c1", token: "t".repeat(40) },
    ]);
    expect(result.state === "ok" && result.items.map((i) => [i.app_user_id, i.status])).toEqual([
      [RAVI, "withdrawn"],
      [SITA, "active"],
    ]);
  });

  it("explains a refused token", async () => {
    vi.stubEnv("APP_API_URL", "https://api.capitup.test/api/v1");
    vi.stubEnv("APP_LEADS_TOKEN", "wrong");
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 403 }));
    expect(await readAppLeads(true)).toEqual({ state: "error", message: "The app server refused the leads token. Check APP_LEADS_TOKEN." });
  });
});
