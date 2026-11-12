import type { Metadata } from "next";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { AlertTriangle, BellRing, HeartPulse, ListChecks } from "lucide-react";

import { Panel, StatCard } from "@/components/analytics/charts";
import { TestAlertButton } from "@/components/admin/test-alert-button";
import { PageHeader } from "@/components/app-shell/page-header";
import { requireSession } from "@/lib/auth";
import { formatDateTime, nowMs } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { CHECK_EVERY_MINUTES, getHealthSummary, type HealthStats } from "@/server/data/monitoring";
import { configuredChannels, healthUrl } from "@/server/monitoring/alerts";

export const metadata: Metadata = { title: "System health" };

const SOURCE_LABELS = { server: "Server", browser: "Browser", job: "Background job" } as const;
const SOURCE_STYLES = {
  server: "bg-rose-50 text-rose-800 border-rose-200",
  browser: "bg-amber-50 text-amber-800 border-amber-200",
  job: "bg-violet-50 text-violet-800 border-violet-200",
} as const;

function uptimeText(s: HealthStats): string {
  return s.uptime == null ? "-" : `${s.uptime}%`;
}

function uptimeHint(s: HealthStats): string {
  if (s.uptime == null) return "No checks yet";
  const missed = s.expected - s.checks;
  return `${s.ok} of ${s.expected} checks passed${missed > 0 ? `, ${missed} missed` : ""}`;
}

// The admin layout already requires an admin; the data function checks again.
export default async function SystemHealthPage() {
  const { ctx, actor } = await requireSession();
  const now = nowMs();
  const [summary, { env }] = await Promise.all([getHealthSummary(ctx, actor, new Date(now)), getCloudflareContext({ async: true })]);
  const channels = configuredChannels(env);
  const target = healthUrl(env);

  const last = summary.last_check;
  const minutesSince = last ? Math.round((now - Date.parse(last.checked_at)) / 60_000) : null;
  // Two missed checks in a row: the cron is not running (Worker down or failing).
  const stale = minutesSince != null && minutesSince > CHECK_EVERY_MINUTES * 2 + 1;
  const status = !last ? "No checks yet" : stale ? "Not checking" : summary.incident.open ? "Problem" : "Healthy";
  const statusTone = !last ? "default" : stale || summary.incident.open ? "urgent" : "success";
  const errors24 = summary.day.errors.server + summary.day.errors.job + summary.day.errors.browser;

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="System health"
        description={`The app checks itself every ${CHECK_EVERY_MINUTES} minutes and alerts you when something breaks.`}
        actions={<TestAlertButton />}
      />

      {summary.incident.open ? (
        <div role="alert" className="mb-6 flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">Problem since {summary.incident.since ? formatDateTime(summary.incident.since) : "recently"}</p>
            <ul className="mt-1 list-disc pl-4">
              {summary.incident.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Status"
          value={status}
          tone={statusTone}
          hint={last ? `Last check ${minutesSince === 0 ? "just now" : `${minutesSince} min ago`}` : "Starts after the next deploy"}
        />
        <StatCard label="Uptime, 24 hours" value={uptimeText(summary.day)} hint={uptimeHint(summary.day)} />
        <StatCard label="Uptime, 7 days" value={uptimeText(summary.week)} hint={uptimeHint(summary.week)} />
        <StatCard
          label="Errors, 24 hours"
          value={errors24}
          tone="urgent"
          quiet={errors24 === 0}
          hint={`${summary.day.errors.server} server, ${summary.day.errors.job} job, ${summary.day.errors.browser} browser`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Recent errors" description="Newest first, kept for 30 days." icon={AlertTriangle} bodyClassName="p-0">
          {summary.recent_errors.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">No errors recorded.</p>
          ) : (
            <ul className="max-h-[480px] divide-y overflow-y-auto">
              {summary.recent_errors.map((e) => (
                <li key={e.id} className="px-5 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("rounded-md border px-1.5 py-0.5 text-xs font-medium", SOURCE_STYLES[e.source])}>
                      {SOURCE_LABELS[e.source]}
                    </span>
                    <span className="font-medium break-all">{e.path ?? "-"}</span>
                    {e.status ? <span className="text-xs text-muted-foreground tabular-nums">HTTP {e.status}</span> : null}
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">{formatDateTime(e.created_at)}</span>
                  </div>
                  {e.message ? <p className="mt-1 text-xs break-words text-muted-foreground">{e.message}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="space-y-6">
          <Panel title="Recent checks" description={target ? `Loads ${target} and asks the database.` : "Database only: no public address set."} icon={ListChecks} bodyClassName="p-0">
            {summary.recent_checks.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted-foreground">No checks yet. The first runs within 5 minutes of deploying.</p>
            ) : (
              <div className="max-h-[320px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-5 py-2 font-medium">Time</th>
                      <th className="px-2 py-2 font-medium">Result</th>
                      <th className="px-2 py-2 text-right font-medium">Site</th>
                      <th className="px-5 py-2 text-right font-medium">Database</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {summary.recent_checks.map((c) => (
                      <tr key={c.id} title={c.problem ?? undefined}>
                        <td className="px-5 py-2 tabular-nums">{formatDateTime(c.checked_at)}</td>
                        <td className="px-2 py-2">
                          <span className={c.ok ? "text-success" : "font-medium text-destructive"}>{c.ok ? "OK" : "Problem"}</span>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {c.site_status == null ? "-" : c.site_status === 0 ? "no answer" : `${c.site_status}, ${c.site_ms} ms`}
                        </td>
                        <td className="px-5 py-2 text-right tabular-nums">{c.db_ok ? `${c.db_ms} ms` : "down"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Alerts" description="Where problems and the 09:00 daily report are sent." icon={BellRing}>
            <ul className="space-y-1.5 text-sm">
              <li>
                <span className="font-medium">Admin bell:</span> on (problem found and problem cleared)
              </li>
              <li>
                <span className="font-medium">Outside the app:</span>{" "}
                {channels.length ? (
                  channels.join(", ")
                ) : (
                  <span className="text-destructive">none yet. Add ALERT_NTFY_TOPIC as a Worker secret to get phone pushes.</span>
                )}
              </li>
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              <HeartPulse className="mr-1 inline size-3.5" />
              If the whole Worker goes down it cannot alert about itself; an outside checker such as UptimeRobot watching /api/health covers that.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}
