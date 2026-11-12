import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { alertSender, configuredChannels, healthUrl, probeSite } from "../../monitoring/alerts";
import { recordFailedRequest } from "../../../worker/errors";
import { runScheduled } from "../../../worker/scheduled";
import { AccessDeniedError } from "../errors";
import {
  BROWSER_ERROR_ALERT,
  ERRORS_PER_HOUR_CAP,
  decideAlert,
  getHealthSummary,
  recordAppError,
  runMonitor,
  sendDailySummary,
  sendTestAlert,
  type Alert,
  type SiteResult,
} from "../monitoring";
import { testWorld } from "./helpers";

let w: Awaited<ReturnType<typeof testWorld>>;

beforeAll(async () => {
  w = await testWorld();
}, 60_000);

afterAll(async () => {
  await w?.dispose();
});

beforeEach(async () => {
  await w.d1.batch([
    w.d1.prepare("delete from health_checks"),
    w.d1.prepare("delete from app_errors"),
    w.d1.prepare("delete from app_settings where key = 'monitor_incident'"),
    w.d1.prepare("delete from notifications"),
  ]);
});

const T0 = new Date("2026-11-12T06:00:00.000Z");
const plus = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const UP: SiteResult = { status: 200, ms: 120, ok: true };
const DOWN: SiteResult = { status: 0, ms: 10_000, ok: false, error: "no answer within 10 s" };
const noSleep = async () => {};

function harness(site: SiteResult = UP) {
  const sent: Alert[] = [];
  const state = { site };
  const options = {
    siteUrl: "https://lms.example.test/api/health",
    probe: async () => state.site,
    send: async (a: Alert) => {
      sent.push(a);
    },
    sleep: noSleep,
  };
  return { sent, state, options };
}

const adminBell = async () =>
  (await w.d1.prepare("select title from notifications where user_id = ? order by id").bind(w.admin.id).all<{ title: string }>()).results;

describe("decideAlert", () => {
  const closed = { open: false, since: null, last_alert_at: null, problems: [] };

  it("stays quiet when all is well", () => {
    expect(decideAlert(closed, [], T0)).toEqual({ alert: null, next: closed });
  });

  it("alerts once when a problem starts, reminds hourly, and says when it clears", () => {
    const first = decideAlert(closed, ["Site not loading (HTTP 502)"], T0);
    expect(first.alert?.kind).toBe("down");
    expect(first.alert?.priority).toBe("urgent");
    expect(first.alert?.body).toContain("11:30 IST");
    expect(first.next.open).toBe(true);

    expect(decideAlert(first.next, ["Site not loading (HTTP 502)"], plus(30)).alert).toBeNull();
    const reminder = decideAlert(first.next, ["Site not loading (HTTP 502)"], plus(60));
    expect(reminder.alert?.kind).toBe("still-down");
    expect(reminder.alert?.title).toContain("since 11:30 IST");

    const cleared = decideAlert(reminder.next, [], plus(75));
    expect(cleared.alert?.kind).toBe("recovered");
    expect(cleared.alert?.body).toContain("after about 75 min");
    expect(cleared.next.open).toBe(false);
  });

  it("uses high, not urgent, priority for errors while the site is up", () => {
    expect(decideAlert(closed, ["2 server errors in the last 5 min"], T0).alert?.priority).toBe("high");
  });
});

describe("runMonitor", () => {
  it("records a healthy check without alerting", async () => {
    const { sent, options } = harness();
    const result = await runMonitor(w.ctx, options, T0);
    expect(result).toMatchObject({ ok: true, problems: [], alert: null });
    expect(sent).toEqual([]);
    const row = await w.d1.prepare("select * from health_checks").first<Record<string, unknown>>();
    expect(row).toMatchObject({ ok: 1, db_ok: 1, site_status: 200, site_ms: 120, server_errors: 0 });
  });

  it("alerts once when the site is down, then reports recovery to the phone and the admin bell", async () => {
    const { sent, state, options } = harness(DOWN);
    await runMonitor(w.ctx, options, T0);
    await runMonitor(w.ctx, options, plus(5));
    expect(sent.map((a) => a.kind)).toEqual(["down"]);
    expect(sent[0].title).toContain("Site not loading (no answer within 10 s)");

    state.site = UP;
    await runMonitor(w.ctx, options, plus(10));
    expect(sent.map((a) => a.kind)).toEqual(["down", "recovered"]);
    // Agents are not told; admins see both in the bell.
    expect((await adminBell()).map((n) => n.title)).toEqual([sent[0].title, "CapitUp LMS is back to normal"]);
    const agentBell = await w.d1.prepare("select count(*) n from notifications where user_id = ?").bind(w.amit.id).first<{ n: number }>();
    expect(agentBell?.n).toBe(0);
  });

  it("retries a failed site check once before calling it down", async () => {
    const { sent, options } = harness();
    let calls = 0;
    options.probe = async () => (++calls === 1 ? DOWN : UP);
    const result = await runMonitor(w.ctx, options, T0);
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(sent).toEqual([]);
  });

  it("alerts on server errors and failed jobs since the last check, with where they happened", async () => {
    const { sent, options } = harness();
    await recordAppError(w.ctx, { source: "server", path: "GET /leads/12?q=secret", status: 500 }, plus(-2));
    await recordAppError(w.ctx, { source: "job", path: "Renewal reminders", message: "D1_ERROR: overloaded" }, plus(-1));
    await recordAppError(w.ctx, { source: "server", path: "GET /old", status: 500 }, plus(-6)); // before the window
    const result = await runMonitor(w.ctx, options, T0);
    expect(result.problems).toEqual([
      "1 server error in the last 5 min: GET /leads/12 (500)",
      "1 failed background job in the last 5 min: Renewal reminders: D1_ERROR: overloaded",
    ]);
    expect(sent[0].kind).toBe("down");
    const row = await w.d1.prepare("select server_errors, job_errors, ok from health_checks").first();
    expect(row).toEqual({ server_errors: 1, job_errors: 1, ok: 0 });
  });

  it("ignores a few browser crashes but alerts on a burst", async () => {
    const { sent, options } = harness();
    for (let i = 0; i < BROWSER_ERROR_ALERT - 1; i++) await recordAppError(w.ctx, { source: "browser", path: "/my-day" }, plus(-1));
    expect((await runMonitor(w.ctx, options, T0)).ok).toBe(true);
    for (let i = 0; i < BROWSER_ERROR_ALERT; i++) await recordAppError(w.ctx, { source: "browser", path: "/my-day" }, plus(4));
    const result = await runMonitor(w.ctx, options, plus(5));
    expect(result.problems).toEqual([`${BROWSER_ERROR_ALERT} pages crashed in people's browsers in the last 5 min`]);
    expect(sent).toHaveLength(1);
  });

  it("still alerts when the send fails, without throwing", async () => {
    const { options } = harness(DOWN);
    options.send = async () => {
      throw new Error("ntfy down");
    };
    await expect(runMonitor(w.ctx, options, T0)).resolves.toMatchObject({ ok: false });
    expect(await adminBell()).toHaveLength(1);
  });

  it("deletes checks and errors older than 30 days", async () => {
    const { options } = harness();
    await runMonitor(w.ctx, options, plus(-31 * 24 * 60));
    await recordAppError(w.ctx, { source: "server", path: "GET /x", status: 500 }, plus(-31 * 24 * 60));
    await runMonitor(w.ctx, options, T0);
    const counts = await w.d1
      .prepare("select (select count(*) from health_checks) checks, (select count(*) from app_errors) errors")
      .first();
    expect(counts).toEqual({ checks: 1, errors: 0 });
  });
});

describe("recordAppError", () => {
  it("drops the query string and caps how many errors an hour are stored", async () => {
    const statements = [];
    for (let i = 0; i < ERRORS_PER_HOUR_CAP - 1; i++) {
      statements.push(
        w.d1.prepare("insert into app_errors (created_at, source, path) values (?, 'browser', '/x')").bind(plus(-30).toISOString()),
      );
    }
    await w.d1.batch(statements);
    await recordAppError(w.ctx, { source: "server", path: "GET /leads?search=Acme", status: 500 }, T0);
    await recordAppError(w.ctx, { source: "server", path: "GET /leads", status: 500 }, T0);
    const rows = await w.d1.prepare("select path from app_errors where source = 'server'").all();
    expect(rows.results).toEqual([{ path: "GET /leads" }]);
  });

  it("records 5xx responses from the Worker, but not the health endpoint", async () => {
    const env = { DB: w.d1 };
    await recordFailedRequest(env, new Request("https://lms.example.test/leads/5?x=1", { method: "POST" }), 500, new TypeError("boom"));
    await recordFailedRequest(env, new Request("https://lms.example.test/api/health"), 503);
    const rows = await w.d1.prepare("select source, path, status, message from app_errors").all();
    expect(rows.results).toEqual([{ source: "server", path: "POST /leads/5", status: 500, message: "TypeError: boom" }]);
  });
});

describe("daily summary and admin page", () => {
  it("reports uptime, missed checks and errors for the last 24 hours", async () => {
    const { options, state } = harness();
    // 12 checks an hour apart would be 288 expected; use 4 at 5-minute steps.
    await runMonitor(w.ctx, options, plus(-20));
    await runMonitor(w.ctx, options, plus(-15));
    state.site = DOWN;
    await runMonitor(w.ctx, options, plus(-10));
    state.site = UP;
    await runMonitor(w.ctx, options, plus(-5));
    const sent: Alert[] = [];
    const alert = await sendDailySummary(w.ctx, async (a) => void sent.push(a), T0);
    expect(alert.title).toBe("CapitUp LMS daily report: 75% up, 0 errors");
    expect(alert.body).toContain("Up 75% (3 of 4 checks passed).");
    expect(sent).toEqual([alert]);
  });

  it("gives admins the summary and keeps it from agents", async () => {
    const { options } = harness();
    await runMonitor(w.ctx, options, plus(-5));
    await recordAppError(w.ctx, { source: "browser", path: "/leads", message: "render: TypeError" }, plus(-1));
    const summary = await getHealthSummary(w.ctx, w.admin, T0);
    expect(summary.last_check?.ok).toBe(true);
    expect(summary.day.errors).toEqual({ server: 0, browser: 1, job: 0 });
    expect(summary.recent_errors[0]).toMatchObject({ source: "browser", path: "/leads" });
    await expect(getHealthSummary(w.ctx, w.amit, T0)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("lets only admins send a test alert", async () => {
    const sent: Alert[] = [];
    const send = async (a: Alert) => void sent.push(a);
    await sendTestAlert(w.ctx, w.admin, send);
    await expect(sendTestAlert(w.ctx, w.amit, send)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(sent.map((a) => a.kind)).toEqual(["test"]);
  });
});

describe("the cron", () => {
  const env = () => ({ DB: w.d1, CARDS: w.ctx.cards, BETTER_AUTH_SECRET: "test-secret-".padEnd(48, "x"), BETTER_AUTH_URL: "https://lms.example.test" }) as unknown as CloudflareEnv;

  it("checks health on 5-minute marks only, and sends the report at 09:00 IST", async () => {
    const sent: Alert[] = [];
    const probed: string[] = [];
    const deps = { send: async (a: Alert) => void sent.push(a), probe: async (url: string) => (probed.push(url), UP), sleep: noSleep };
    await runScheduled(env(), new Date("2026-11-12T03:29:00Z"), deps);
    expect(probed).toEqual([]);
    await runScheduled(env(), new Date("2026-11-12T03:30:00Z"), deps);
    expect(probed).toEqual(["https://lms.example.test/api/health"]);
    expect(sent.map((a) => a.kind)).toEqual(["summary"]);
  });
});

describe("alert channels", () => {
  it("lists configured channels without revealing them", () => {
    expect(configuredChannels({})).toEqual([]);
    expect(configuredChannels({ ALERT_NTFY_TOPIC: "x", ALERT_WEBHOOK_URL: "https://hooks", ALERT_TELEGRAM_BOT_TOKEN: "t" })).toEqual([
      "Phone push (ntfy)",
      "Webhook",
    ]);
    expect(healthUrl({ BETTER_AUTH_URL: "https://lms.example.test/" })).toBe("https://lms.example.test/api/health");
    expect(healthUrl({ BETTER_AUTH_URL: "https://a", MONITOR_URL: "https://b/health" })).toBe("https://b/health");
  });

  it("posts to ntfy and the webhook, and tolerates one failing", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: url.includes("hooks") ? 500 : 200 });
    }) as unknown as typeof fetch;
    const send = alertSender(
      { ALERT_NTFY_TOPIC: "capitup-test", ALERT_WEBHOOK_URL: "https://hooks.example.test/x", BETTER_AUTH_URL: "https://lms.example.test" },
      fetcher,
    );
    await send({ kind: "down", title: "T", body: "B", priority: "urgent", tags: ["rotating_light"] });
    expect(calls[0]).toEqual({
      url: "https://ntfy.sh",
      body: { topic: "capitup-test", title: "T", message: "B", priority: 5, tags: ["rotating_light"], click: "https://lms.example.test/admin/health" },
    });
    expect(calls[1].body.text).toContain("*T*");
  });

  it("throws when every channel fails, so the caller can log it", async () => {
    const fetcher = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    await expect(alertSender({ ALERT_NTFY_TOPIC: "t" }, fetcher)({ kind: "test", title: "T", body: "B", priority: "low", tags: [] })).rejects.toThrow();
  });

  it("probes the health endpoint and reads its answer", async () => {
    const ok = (async () => Response.json({ status: "ok" })) as unknown as typeof fetch;
    const bad = (async () => Response.json({ status: "error" }, { status: 503 })) as unknown as typeof fetch;
    const dead = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await probeSite("https://a/api/health", ok)).toMatchObject({ ok: true, status: 200 });
    expect(await probeSite("https://a/api/health", bad)).toMatchObject({ ok: false, status: 503, error: "HTTP 503" });
    expect(await probeSite("https://a/api/health", dead)).toMatchObject({ ok: false, status: 0, error: "could not connect" });
  });
});
