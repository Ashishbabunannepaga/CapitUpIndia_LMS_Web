import "server-only";

import { and, asc, count, desc, eq, gte, lt, sql } from "drizzle-orm";

import { appErrors, appSettings, healthChecks, notifications, profiles } from "../db/schema";
import { assertAdmin, type Actor } from "./actor";
import type { DataContext } from "./context";

// Uptime and error monitoring. The per-minute cron (src/worker/scheduled.ts)
// runs runMonitor() every CHECK_EVERY_MINUTES minutes:
//   1. asks D1 for `select 1` (retried once),
//   2. loads the public /api/health through CloudFront, like a visitor would
//      (retried once), and
//   3. counts the server errors, failed background jobs and browser crashes
//      recorded since the last check (recordAppError).
// Each run writes one health_checks row. When something is wrong it alerts
// (phone push / webhook via the AlertSender, plus every admin's bell) once,
// reminds every REMIND_EVERY_MINUTES while it lasts, and says when it clears.
// A Worker that is completely down cannot run its own cron, so an outside
// checker (UptimeRobot, see docs/monitoring.md) covers that case.

export type MonitorContext = Pick<DataContext, "db">;

export const CHECK_EVERY_MINUTES = 5;
export const REMIND_EVERY_MINUTES = 60;
/** Health checks and recorded errors older than this are deleted. */
export const KEEP_DAYS = 30;
/** Browser crashes in one window that raise an alert (one or two are usually a bad connection). */
export const BROWSER_ERROR_ALERT = 10;
/** At most this many errors are stored per hour, so an error storm cannot fill D1. */
export const ERRORS_PER_HOUR_CAP = 300;
const INCIDENT_KEY = "monitor_incident";
const MINUTE = 60_000;

export type AppErrorSource = "server" | "browser" | "job";
export type AppErrorInput = {
  source: AppErrorSource;
  /** "GET /leads/12" for requests, a job name for jobs. The query string is dropped. */
  path?: string | null;
  status?: number | null;
  message?: string | null;
  userId?: string | null;
};

export type Alert = {
  kind: "down" | "still-down" | "recovered" | "summary" | "test";
  title: string;
  body: string;
  priority: "urgent" | "high" | "default" | "low";
  tags: string[];
};
export type AlertSender = (alert: Alert) => Promise<void>;

export type SiteResult = { status: number; ms: number; ok: boolean; error?: string };
export type SiteProbe = (url: string) => Promise<SiteResult>;

export type Incident = {
  open: boolean;
  since: string | null;
  last_alert_at: string | null;
  problems: string[];
};
const NO_INCIDENT: Incident = { open: false, since: null, last_alert_at: null, problems: [] };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const ago = (at: Date, minutes: number) => new Date(at.getTime() - minutes * MINUTE).toISOString();

/** "14:05" in India time, for alert text. */
export function istClock(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(iso),
  );
}

/**
 * Stores one error for the monitor. Never throws: recording a failure must
 * not cause another. Capped at ERRORS_PER_HOUR_CAP rows an hour.
 */
export async function recordAppError(ctx: MonitorContext, input: AppErrorInput, at: Date = new Date()): Promise<void> {
  const path = input.path ? input.path.split("?")[0].slice(0, 300) : null;
  const message = input.message ? input.message.slice(0, 1000) : null;
  try {
    await ctx.db.run(sql`
      insert into app_errors (created_at, source, path, status, message, user_id)
      select ${at.toISOString()}, ${input.source}, ${path}, ${input.status ?? null}, ${message}, ${input.userId ?? null}
      where (select count(*) from app_errors where created_at >= ${ago(at, 60)}) < ${ERRORS_PER_HOUR_CAP}`);
  } catch (error) {
    console.error("Could not record an app error.", errorText(error));
  }
}

/** One quick database round trip. Used by /api/health and the monitor. */
export async function checkDatabase(ctx: MonitorContext): Promise<{ ok: boolean; ms: number; error?: string }> {
  const start = Date.now();
  try {
    await ctx.db.get(sql`select 1 as one`);
    return { ok: true, ms: Date.now() - start };
  } catch (error) {
    return { ok: false, ms: Date.now() - start, error: errorText(error).slice(0, 200) };
  }
}

/**
 * What to send, given the open incident (if any) and this run's problems.
 * Pure, so the alert rules are easy to test.
 */
export function decideAlert(prev: Incident, problems: string[], at: Date): { alert: Alert | null; next: Incident } {
  const now = at.toISOString();
  if (problems.length) {
    const severe = problems.some((p) => p.startsWith("Site") || p.startsWith("Database"));
    if (!prev.open) {
      return {
        alert: {
          kind: "down",
          title: `CapitUp LMS: ${problems[0]}`.slice(0, 200),
          body: `${problems.join("\n")}\n\nNoticed at ${istClock(now)} IST. Details: Admin > System health.`,
          priority: severe ? "urgent" : "high",
          tags: ["rotating_light"],
        },
        next: { open: true, since: now, last_alert_at: now, problems },
      };
    }
    const due = !prev.last_alert_at || at.getTime() - Date.parse(prev.last_alert_at) >= REMIND_EVERY_MINUTES * MINUTE;
    if (due) {
      return {
        alert: {
          kind: "still-down",
          title: `CapitUp LMS still has a problem (since ${istClock(prev.since ?? now)} IST)`,
          body: `${problems.join("\n")}\n\nChecked at ${istClock(now)} IST.`,
          priority: severe ? "urgent" : "high",
          tags: ["warning"],
        },
        next: { ...prev, last_alert_at: now, problems },
      };
    }
    return { alert: null, next: { ...prev, problems } };
  }
  if (prev.open) {
    const minutes = prev.since ? Math.max(1, Math.round((at.getTime() - Date.parse(prev.since)) / MINUTE)) : null;
    return {
      alert: {
        kind: "recovered",
        title: "CapitUp LMS is back to normal",
        body: `All checks passed at ${istClock(now)} IST${minutes ? `, after about ${minutes} min` : ""}.\nIt was: ${prev.problems.join("; ")}`,
        priority: "default",
        tags: ["white_check_mark"],
      },
      next: NO_INCIDENT,
    };
  }
  return { alert: null, next: NO_INCIDENT };
}

type ErrorSample = { source: AppErrorSource; path: string | null; status: number | null; message: string | null };

/** "3 server errors: GET /leads (500), POST /intake (500)". */
function describeErrors(n: number, label: string, samples: ErrorSample[]): string {
  const where = [...new Set(samples.map((s) => `${s.path ?? "?"}${s.status ? ` (${s.status})` : ""}${s.message ? `: ${s.message.slice(0, 80)}` : ""}`))]
    .slice(0, 3)
    .join(", ");
  return `${n} ${label}${n === 1 ? "" : "s"} in the last ${CHECK_EVERY_MINUTES} min${where ? `: ${where}` : ""}`;
}

async function readIncident(ctx: MonitorContext): Promise<Incident> {
  const row = await ctx.db.query.appSettings.findFirst({ where: eq(appSettings.key, INCIDENT_KEY) });
  const value = row?.value as Partial<Incident> | undefined;
  return value && typeof value === "object" ? { ...NO_INCIDENT, ...value } : NO_INCIDENT;
}

function saveIncident(ctx: MonitorContext, incident: Incident) {
  return ctx.db
    .insert(appSettings)
    .values({ key: INCIDENT_KEY, value: incident, description: "Monitoring: the open incident, if any (src/server/data/monitoring.ts)." })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: incident } });
}

async function notifyAdmins(ctx: MonitorContext, title: string, body: string): Promise<void> {
  const admins = await ctx.db
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.role, "ADMIN"), eq(profiles.is_active, true)));
  const rows = admins.map(({ id }) => ({ user_id: id, kind: "other" as const, title: title.slice(0, 300), body: body.slice(0, 2000) }));
  for (let i = 0; i < rows.length; i += 10) await ctx.db.insert(notifications).values(rows.slice(i, i + 10));
}

async function safeSend(send: AlertSender, alert: Alert): Promise<void> {
  try {
    await send(alert);
  } catch (error) {
    console.error("Could not send a monitoring alert.", errorText(error));
  }
}

// When D1 itself is down nothing can be stored, so repeat alerts are spaced
// by the isolate's memory instead (best effort: a new isolate alerts again).
let lastDatabaseAlert = 0;

export type MonitorOptions = {
  /** Full URL of the public health endpoint, or null to skip the site check. */
  siteUrl: string | null;
  probe: SiteProbe;
  send: AlertSender;
  /** Waits between retries; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
};

export type MonitorResult = { ok: boolean; problems: string[]; alert: Alert | null };

/** One health check: probe, record, and alert if needed. Called by the cron. */
export async function runMonitor(ctx: MonitorContext, options: MonitorOptions, at: Date = new Date()): Promise<MonitorResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let db = await checkDatabase(ctx);
  if (!db.ok) {
    await sleep(2_000);
    db = await checkDatabase(ctx);
  }
  let site: SiteResult | null = null;
  if (options.siteUrl) {
    site = await options.probe(options.siteUrl);
    if (!site.ok) {
      await sleep(3_000);
      site = await options.probe(options.siteUrl);
    }
  }

  const siteProblem = site && !site.ok ? `Site not loading (${site.error ?? `HTTP ${site.status}`})` : null;

  if (!db.ok) {
    const problems = [`Database not answering (${db.error ?? "unknown error"})`, ...(siteProblem ? [siteProblem] : [])];
    console.error(JSON.stringify({ event: "health_check", ok: false, problems }));
    let alert: Alert | null = null;
    if (at.getTime() - lastDatabaseAlert >= REMIND_EVERY_MINUTES * MINUTE) {
      lastDatabaseAlert = at.getTime();
      alert = decideAlert(NO_INCIDENT, problems, at).alert;
      if (alert) await safeSend(options.send, alert);
    }
    return { ok: false, problems, alert };
  }
  lastDatabaseAlert = 0;

  const since = ago(at, CHECK_EVERY_MINUTES);
  const inWindow = and(gte(appErrors.created_at, since), lt(appErrors.created_at, at.toISOString()));
  const [counts, samples] = await ctx.db.batch([
    ctx.db.select({ source: appErrors.source, n: count() }).from(appErrors).where(inWindow).groupBy(appErrors.source),
    ctx.db
      .select({ source: appErrors.source, path: appErrors.path, status: appErrors.status, message: appErrors.message })
      .from(appErrors)
      .where(and(inWindow, sql`${appErrors.source} in ('server', 'job')`))
      .orderBy(desc(appErrors.created_at))
      .limit(10),
  ]);
  const n = (source: AppErrorSource) => counts.find((c) => c.source === source)?.n ?? 0;
  const server = n("server");
  const job = n("job");
  const browser = n("browser");

  const problems: string[] = [];
  if (siteProblem) problems.push(siteProblem);
  if (server > 0) problems.push(describeErrors(server, "server error", samples.filter((s) => s.source === "server")));
  if (job > 0) problems.push(describeErrors(job, "failed background job", samples.filter((s) => s.source === "job")));
  if (browser >= BROWSER_ERROR_ALERT) problems.push(`${browser} pages crashed in people's browsers in the last ${CHECK_EVERY_MINUTES} min`);

  const prev = await readIncident(ctx);
  const { alert, next } = decideAlert(prev, problems, at);

  const ok = problems.length === 0;
  const keepFrom = ago(at, KEEP_DAYS * 24 * 60);
  await ctx.db.batch([
    ctx.db.insert(healthChecks).values({
      checked_at: at.toISOString(),
      ok,
      db_ok: true,
      db_ms: db.ms,
      site_status: site ? site.status : null,
      site_ms: site ? site.ms : null,
      server_errors: server,
      browser_errors: browser,
      job_errors: job,
      problem: ok ? null : problems.join("\n").slice(0, 1000),
    }),
    ctx.db.delete(healthChecks).where(lt(healthChecks.checked_at, keepFrom)),
    ctx.db.delete(appErrors).where(lt(appErrors.created_at, keepFrom)),
    saveIncident(ctx, next),
  ]);
  console.log(JSON.stringify({ event: "health_check", ok, db_ms: db.ms, site_status: site?.status, site_ms: site?.ms, server, job, browser }));

  if (alert) {
    await safeSend(options.send, alert);
    if (alert.kind !== "still-down") await notifyAdmins(ctx, alert.title, alert.body);
  }
  return { ok, problems, alert };
}

export type HealthStats = {
  checks: number;
  ok: number;
  /** Checks the cron should have made; fewer means it did not run (Worker down or failing). */
  expected: number;
  uptime: number | null;
  avg_site_ms: number | null;
  max_site_ms: number | null;
  errors: Record<AppErrorSource, number>;
};

async function statsSince(ctx: MonitorContext, from: string, at: Date): Promise<HealthStats> {
  const to = at.toISOString();
  const [[checks], [first], errors] = await ctx.db.batch([
    ctx.db
      .select({
        total: count(),
        ok: sql<number>`coalesce(sum(${healthChecks.ok}), 0)`,
        avg_site: sql<number | null>`avg(${healthChecks.site_ms})`,
        max_site: sql<number | null>`max(${healthChecks.site_ms})`,
      })
      .from(healthChecks)
      .where(and(gte(healthChecks.checked_at, from), lt(healthChecks.checked_at, to))),
    ctx.db.select({ at: healthChecks.checked_at }).from(healthChecks).orderBy(asc(healthChecks.checked_at)).limit(1),
    ctx.db
      .select({ source: appErrors.source, n: count() })
      .from(appErrors)
      .where(and(gte(appErrors.created_at, from), lt(appErrors.created_at, to)))
      .groupBy(appErrors.source),
  ]);
  const total = checks?.total ?? 0;
  const okCount = Number(checks?.ok ?? 0);
  const start = Math.max(Date.parse(from), first ? Date.parse(first.at) : at.getTime());
  const expected = Math.max(total, Math.floor((at.getTime() - start) / (CHECK_EVERY_MINUTES * MINUTE)));
  const byErr = (s: AppErrorSource) => errors.find((e) => e.source === s)?.n ?? 0;
  return {
    checks: total,
    ok: okCount,
    expected,
    uptime: expected ? Math.round((okCount / expected) * 1000) / 10 : null,
    avg_site_ms: checks?.avg_site == null ? null : Math.round(Number(checks.avg_site)),
    max_site_ms: checks?.max_site == null ? null : Number(checks.max_site),
    errors: { server: byErr("server"), browser: byErr("browser"), job: byErr("job") },
  };
}

/** The morning report: the last 24 hours in one push. Called by the cron at 09:00 IST. */
export async function sendDailySummary(ctx: MonitorContext, send: AlertSender, at: Date = new Date()): Promise<Alert> {
  const s = await statsSince(ctx, ago(at, 24 * 60), at);
  const totalErrors = s.errors.server + s.errors.job + s.errors.browser;
  const missed = s.expected - s.checks;
  const lines = [
    s.uptime == null ? "No health checks yet." : `Up ${s.uptime}% (${s.ok} of ${s.expected} checks passed${missed > 0 ? `, ${missed} missed` : ""}).`,
    s.avg_site_ms == null ? null : `Health page answered in ${s.avg_site_ms} ms on average, slowest ${s.max_site_ms} ms.`,
    `Server errors: ${s.errors.server}. Failed background jobs: ${s.errors.job}. Browser crashes: ${s.errors.browser}.`,
  ].filter(Boolean);
  const healthy = s.uptime != null && s.uptime >= 99.5 && s.errors.server + s.errors.job === 0;
  const alert: Alert = {
    kind: "summary",
    title: `CapitUp LMS daily report: ${s.uptime == null ? "no data" : `${s.uptime}% up`}, ${totalErrors} error${totalErrors === 1 ? "" : "s"}`,
    body: `Last 24 hours:\n${lines.join("\n")}`,
    priority: healthy ? "low" : "default",
    tags: [healthy ? "bar_chart" : "warning"],
  };
  await safeSend(send, alert);
  return alert;
}

export type HealthSummary = {
  last_check: typeof healthChecks.$inferSelect | null;
  incident: Incident;
  day: HealthStats;
  week: HealthStats;
  recent_checks: (typeof healthChecks.$inferSelect)[];
  recent_errors: (typeof appErrors.$inferSelect)[];
};

/** Everything Admin > System health shows. Admins only. */
export async function getHealthSummary(ctx: DataContext, actor: Actor, at: Date = new Date()): Promise<HealthSummary> {
  assertAdmin(actor);
  const [day, week, recent, errors, incident] = await Promise.all([
    statsSince(ctx, ago(at, 24 * 60), at),
    statsSince(ctx, ago(at, 7 * 24 * 60), at),
    ctx.db.select().from(healthChecks).orderBy(desc(healthChecks.checked_at)).limit(24),
    ctx.db.select().from(appErrors).orderBy(desc(appErrors.created_at), desc(appErrors.id)).limit(50),
    readIncident(ctx),
  ]);
  return { last_check: recent[0] ?? null, incident, day, week, recent_checks: recent, recent_errors: errors };
}

/** Admin > System health > Send test alert. */
export async function sendTestAlert(ctx: DataContext, actor: Actor, send: AlertSender): Promise<void> {
  assertAdmin(actor);
  await send({
    kind: "test",
    title: "CapitUp LMS test alert",
    body: `${actor.full_name} sent this from Admin > System health at ${istClock(new Date().toISOString())} IST. Alerts reach you here.`,
    priority: "default",
    tags: ["bell"],
  });
}
