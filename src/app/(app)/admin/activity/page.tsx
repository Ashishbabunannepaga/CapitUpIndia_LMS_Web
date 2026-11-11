import type { Metadata } from "next";
import Link from "next/link";
import { Activity, Download, History, Radio, Users } from "lucide-react";

import { Panel } from "@/components/analytics/charts";
import { PageHeader } from "@/components/app-shell/page-header";
import { RealtimeRefresh } from "@/components/app-shell/realtime-refresh";
import { StatusBadge } from "@/components/leads/lead-badges";
import { LeadLink } from "@/components/leads/lead-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { requireSession } from "@/lib/auth";
import type { LeadStatus } from "@/lib/database.types";
import { formatDate, nowMs, startOfBusinessDay, todayInBusinessTz, addDays } from "@/lib/dates";
import { ACTIVITY_KIND_LABELS, ACTIVITY_KINDS, isActivityKind, LEAD_STATUSES, type ActivityKind } from "@/lib/domain";
import { getTeam } from "@/lib/leads";
import { istStamp } from "@/lib/reports/monthly-report";
import { cn } from "@/lib/utils";
import { listActivity, listLeadTracker, summariseByAgent, type ActivityItem } from "@/server/data/activity";
import { changeStamp } from "@/server/data/changes";

export const metadata: Metadata = { title: "Team activity" };

/** How often the live tracker asks whether anything changed (one D1 row read). */
const LIVE_INTERVAL_MS = 15_000;

const KIND_STYLES: Record<ActivityKind, string> = {
  lead_created: "bg-brand-50 text-brand-800 border-brand-200",
  status_changed: "bg-sky-50 text-sky-800 border-sky-200",
  lead_assigned: "bg-violet-50 text-violet-800 border-violet-200",
  lead_edited: "bg-slate-50 text-slate-700 border-slate-200",
  card_uploaded: "bg-gold-50 text-gold-800 border-gold-200",
  note_added: "bg-amber-50 text-amber-800 border-amber-200",
  task_created: "bg-orange-50 text-orange-800 border-orange-200",
  task_completed: "bg-green-50 text-green-800 border-green-200",
  contact: "bg-teal-50 text-teal-800 border-teal-200",
  lead_deleted: "bg-rose-50 text-rose-800 border-rose-200",
};

function KindBadge({ kind }: { kind: ActivityKind }) {
  return (
    <span className={cn("inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap", KIND_STYLES[kind])}>
      {ACTIVITY_KIND_LABELS[kind]}
    </span>
  );
}

function timeAgo(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function LeadName({ item }: { item: Pick<ActivityItem, "lead_id" | "lead_name" | "lead_exists"> }) {
  if (!item.lead_id) return <span className="text-muted-foreground">-</span>;
  if (!item.lead_exists) return <span className="text-muted-foreground line-through">{item.lead_name || `Lead ${item.lead_id}`}</span>;
  return (
    <LeadLink href={`/leads/${item.lead_id}`} className="font-medium hover:text-primary hover:underline">
      {item.lead_name}
    </LeadLink>
  );
}

const param = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";
const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

// The admin layout already requires an admin; every data function checks again.
export default async function ActivityPage({ searchParams }: PageProps<"/admin/activity">) {
  const { ctx, actor } = await requireSession();
  const query = await searchParams;
  const tab = param(query.tab) === "log" ? "log" : "tracker";
  const now = nowMs();
  const today = todayInBusinessTz(new Date(now));
  const thisMonth = today.slice(0, 7);
  const team = await getTeam();

  const tabs = (
    <nav className="mb-5 inline-flex rounded-lg border bg-card p-1 text-sm shadow-xs" aria-label="Views">
      {[
        { key: "tracker", label: "Live leads tracker", icon: Radio },
        { key: "log", label: "Activity log", icon: History },
      ].map(({ key, label, icon: Icon }) => (
        <Link
          key={key}
          href={key === "tracker" ? "/admin/activity" : "/admin/activity?tab=log"}
          aria-current={tab === key ? "page" : undefined}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors",
            tab === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-4" />
          {label}
        </Link>
      ))}
    </nav>
  );

  const header = (
    <PageHeader
      eyebrow="Admin"
      title="Team activity"
      description="What every agent is doing: a live view of all leads, a log of every action, and a monthly Excel report."
      actions={
        <form action="/admin/activity/report" method="get" className="flex items-center gap-2">
          <label htmlFor="report-month" className="sr-only">
            Report month
          </label>
          <Input id="report-month" type="month" name="month" defaultValue={thisMonth} max={thisMonth} required className="h-9 w-40" />
          <Button type="submit">
            <Download />
            Monthly report
          </Button>
        </form>
      }
    />
  );

  if (tab === "log") {
    const agent = param(query.agent);
    const kindParam = param(query.kind);
    const kind = isActivityKind(kindParam) ? kindParam : undefined;
    const from = isDate(param(query.from)) ? param(query.from) : addDays(today, -6);
    const to = isDate(param(query.to)) ? param(query.to) : today;
    const items = await listActivity(ctx, actor, {
      agentId: agent || undefined,
      kind,
      from: startOfBusinessDay(from),
      to: startOfBusinessDay(addDays(to, 1)),
      limit: 300,
    });

    return (
      <>
        {header}
        {tabs}
        <form method="get" className="mb-4 grid gap-2 rounded-xl border bg-card p-3 shadow-xs sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto_auto_auto]">
          <input type="hidden" name="tab" value="log" />
          <NativeSelect name="agent" defaultValue={agent} aria-label="Agent">
            <option value="">Everyone</option>
            {team.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name}
                {m.is_active ? "" : " (disabled)"}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect name="kind" defaultValue={kind ?? ""} aria-label="Action">
            <option value="">All actions</option>
            {ACTIVITY_KINDS.map((k) => (
              <option key={k} value={k}>
                {ACTIVITY_KIND_LABELS[k]}
              </option>
            ))}
          </NativeSelect>
          <Input type="date" name="from" defaultValue={from} max={today} aria-label="From" />
          <Input type="date" name="to" defaultValue={to} max={today} aria-label="To" />
          <Button type="submit" variant="outline">
            Apply
          </Button>
        </form>

        <p className="mb-2 text-sm text-muted-foreground">
          {items.length === 0
            ? "Nothing matches these filters."
            : `${items.length === 300 ? "Latest 300" : items.length} action${items.length === 1 ? "" : "s"} from ${formatDate(from)} to ${formatDate(to)}.`}
          {items.length === 300 ? " Narrow the filters or download the monthly report for everything." : ""}
        </p>
        {items.length > 0 ? (
          <div className="overflow-x-auto rounded-2xl border bg-card shadow-card">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="text-left text-xs font-medium text-muted-foreground">
                <tr className="border-b">
                  <th className="px-4 py-2">When (IST)</th>
                  <th className="px-3 py-2">Agent</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Lead</th>
                  <th className="px-4 py-2">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map((item, i) => (
                  <tr key={`${item.at}-${i}`} className="align-top transition-colors hover:bg-muted/50">
                    <td className="px-4 py-2 whitespace-nowrap tabular-nums text-muted-foreground">{istStamp(item.at)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{item.agent_name}</td>
                    <td className="px-3 py-2">
                      <KindBadge kind={item.kind} />
                    </td>
                    <td className="px-3 py-2">
                      <LeadName item={item} />
                    </td>
                    <td className="max-w-md px-4 py-2 break-words text-muted-foreground">{item.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </>
    );
  }

  // --- Live leads tracker
  const agent = param(query.agent);
  const statusParam = param(query.status);
  const status = (LEAD_STATUSES as readonly string[]).includes(statusParam) ? statusParam : "";
  const q = param(query.q).slice(0, 100);
  const [stamp, rows, todayItems] = await Promise.all([
    changeStamp(ctx, actor),
    listLeadTracker(ctx, actor, { agentId: agent || undefined, status: status || undefined, q, limit: 150 }),
    listActivity(ctx, actor, { from: startOfBusinessDay(today), limit: 5_000 }),
  ]);
  const people = summariseByAgent(todayItems);
  const latest = todayItems.slice(0, 12);

  return (
    <>
      <RealtimeRefresh stamp={stamp} intervalMs={LIVE_INTERVAL_MS} />
      {header}
      {tabs}

      <p className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
        <span className="relative flex size-2.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-2.5 rounded-full bg-success" />
        </span>
        Live. Updated {istStamp(new Date(now).toISOString()).slice(11)} IST; changes appear within {LIVE_INTERVAL_MS / 1000} seconds while this tab is open.
      </p>

      <div className="mb-6 grid items-start gap-4 xl:grid-cols-[2fr_1fr]">
        <Panel title="Today, by person" icon={Users} description="Actions since midnight IST.">
          {people.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No activity yet today.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="text-left text-xs font-medium text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-2 pr-3">Person</th>
                    <th className="px-2 py-2 text-right">Actions</th>
                    <th className="px-2 py-2 text-right">Status updates</th>
                    <th className="px-2 py-2 text-right">Notes</th>
                    <th className="px-2 py-2 text-right">Calls / msgs</th>
                    <th className="px-2 py-2 text-right">Tasks done</th>
                    <th className="px-2 py-2 text-right">New leads</th>
                    <th className="py-2 pl-2 text-right">Last active</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {people.map((p) => (
                    <tr key={p.agent_id ?? "system"}>
                      <td className="py-2 pr-3 font-medium">
                        {p.agent_id ? (
                          <Link href={`/admin/activity?tab=log&agent=${p.agent_id}&from=${today}&to=${today}`} className="hover:text-primary hover:underline">
                            {p.agent_name}
                          </Link>
                        ) : (
                          p.agent_name
                        )}
                      </td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">{p.actions}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{p.status_changes}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{p.notes}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{p.contacts}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{p.tasks_completed}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{p.leads_created}</td>
                      <td className="py-2 pl-2 text-right whitespace-nowrap text-muted-foreground">{timeAgo(p.last_at, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="Just now"
          icon={Activity}
          actions={
            <Link href="/admin/activity?tab=log" className="text-xs font-medium text-primary hover:underline">
              Full log
            </Link>
          }
        >
          {latest.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">Nothing yet today.</p>
          ) : (
            <ol className="space-y-2.5 text-sm">
              {latest.map((item, i) => (
                <li key={`${item.at}-${i}`} className="flex gap-2">
                  <span className="mt-0.5 w-14 shrink-0 text-xs tabular-nums text-muted-foreground">{istStamp(item.at).slice(11)}</span>
                  <div className="min-w-0">
                    <p className="truncate">
                      <span className="font-medium">{item.agent_name}</span>{" "}
                      <span className="text-muted-foreground">{ACTIVITY_KIND_LABELS[item.kind].toLowerCase()}</span>{" "}
                      <LeadName item={item} />
                    </p>
                    {item.detail ? <p className="truncate text-xs text-muted-foreground">{item.detail}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>

      <form method="get" className="mb-3 grid gap-2 rounded-xl border bg-card p-3 shadow-xs sm:grid-cols-2 lg:grid-cols-[1fr_1fr_2fr_auto]">
        <NativeSelect name="agent" defaultValue={agent} aria-label="Owner">
          <option value="">All owners</option>
          <option value="unassigned">Unassigned</option>
          {team.map((m) => (
            <option key={m.id} value={m.id}>
              {m.full_name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="status" defaultValue={status} aria-label="Status">
          <option value="">All statuses</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </NativeSelect>
        <Input type="search" name="q" defaultValue={q} placeholder="Search company" aria-label="Search company" />
        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>

      <p className="mb-2 text-sm text-muted-foreground">
        {rows.length === 0
          ? "No leads match."
          : `${rows.length === 150 ? "150 most recently active" : rows.length} lead${rows.length === 1 ? "" : "s"}, most recent activity first.`}
      </p>
      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-2xl border bg-card shadow-card">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="text-left text-xs font-medium text-muted-foreground">
              <tr className="border-b">
                <th className="px-4 py-2">Lead</th>
                <th className="px-3 py-2">Owner</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Type · product</th>
                <th className="px-3 py-2">Renewal</th>
                <th className="px-3 py-2">Last activity</th>
                <th className="px-3 py-2 text-right">Notes</th>
                <th className="px-4 py-2 text-right">Open tasks</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => {
                const fresh = now - Date.parse(row.last_activity_at) < 10 * 60_000;
                return (
                  <tr key={row.id} className={cn("transition-colors hover:bg-muted/50", fresh && "bg-brand-50/60")}>
                    <td className="px-4 py-2">
                      <span className="flex items-center gap-2">
                        {fresh ? <span className="size-2 shrink-0 rounded-full bg-success" title="Active in the last 10 minutes" /> : null}
                        <LeadLink href={`/leads/${row.id}`} className="font-medium hover:text-primary hover:underline">
                          {row.client_name}
                        </LeadLink>
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{row.agent_name ?? <span className="text-muted-foreground">Unassigned</span>}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={row.status as LeadStatus} />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                      {row.type} · {row.policy_product}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatDate(row.renewal_date)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span title={istStamp(row.last_activity_at)}>{timeAgo(row.last_activity_at, now)}</span>
                      {row.last_changed_by ? <span className="block text-xs text-muted-foreground">last saved by {row.last_changed_by}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.notes}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{row.open_tasks}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
