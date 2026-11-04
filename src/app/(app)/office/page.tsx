import type { Metadata } from "next";
import Link from "next/link";
import {
  AlarmClock,
  CalendarClock,
  ExternalLink,
  FileText,
  Gamepad2,
  LayoutDashboard,
  PhoneCall,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Users,
} from "lucide-react";

import { BarList, Panel, StatCard } from "@/components/analytics/charts";
import { PageHeader } from "@/components/app-shell/page-header";
import { CallRequests, requestsHref, type RequestsQuery } from "@/components/office/call-requests";
import { Empty, Initials, ResultNote, Tag } from "@/components/office/office-bits";
import { Games, Policies, PolicyDetail, type PoliciesQuery } from "@/components/office/policies";
import { Renewals, type RenewalsQuery } from "@/components/office/renewals";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/action-errors";
import { formatCount } from "@/lib/analytics";
import { isAdmin, requireProfile } from "@/lib/auth";
import { getTeam } from "@/lib/leads";
import {
  getCallRequest,
  getCallRequests,
  getOfficeGames,
  getOfficeOverview,
  getOfficePolicies,
  getOfficePolicy,
  getOfficeRenewals,
  getOfficeReport,
  type OfficeOverview,
} from "@/lib/office";
import { OFFICE_LEAD_STEPS, OFFICE_SOURCE, OFFICE_TYPE, leadStep, officeAgo } from "@/lib/office-labels";
import { cn } from "@/lib/utils";

import { refreshOfficeAction } from "./actions";

export const metadata: Metadata = { title: "Office portal" };

const TABS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "requests", label: "Call requests", icon: PhoneCall },
  { id: "renewals", label: "Renewals due", icon: CalendarClock },
  { id: "policies", label: "Policies & reports", icon: FileText },
  { id: "games", label: "Protection game", icon: Gamepad2 },
] as const;
type TabId = (typeof TABS)[number]["id"];

const DESCRIPTIONS: Record<TabId, string> = {
  overview: "Policies, gap reports and call requests from Capitup AI on capitupindia.com.",
  requests: "People who asked Capitup for a call. Record follow-up, read their gap report, or hand them to an agent as an LMS lead.",
  renewals: "Client policies that end soon, read from their gap reports. Offer renewal quotes before the cover ends.",
  policies: "Every uploaded policy. Open one to read the gap report the client received.",
  games: "Results visitors chose to save from the protection game.",
};

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.slice(0, 400) ?? "";
}

function label(map: Record<string, string>, key: string): string {
  return map[key] ?? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function bars(counts: Record<string, number> | undefined, labels: Record<string, string> = {}) {
  return Object.entries(counts ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({ label: label(labels, key), value }));
}

function trend(week: number, previous: number): string {
  if (previous === 0) return week === 0 ? "None in the last 2 weeks" : `${week} this week`;
  const change = Math.round(((week - previous) / previous) * 100);
  return `${week} this week, ${change >= 0 ? "+" : ""}${change}% vs last week`;
}

const fetchedFormat = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

const LEAD_LABELS = Object.fromEntries(OFFICE_LEAD_STEPS.map((s) => [s.id, s.label]));

/** An office read that failed becomes a message on the page, not an error screen. */
async function attempt<T>(work: () => Promise<T>): Promise<{ value: T } | { error: string }> {
  try {
    return { value: await work() };
  } catch (error) {
    return { error: friendlyError(error) };
  }
}

export default async function OfficePage({ searchParams }: PageProps<"/office">) {
  const params = await searchParams;
  const [profile, overview] = await Promise.all([requireProfile(), getOfficeOverview()]);
  const admin = isAdmin(profile);
  const requested = one(params.tab) as TabId;
  const tab: TabId = admin && TABS.some((t) => t.id === requested) ? requested : "overview";
  const connected = overview.state !== "not-configured";
  const here = `/office?${new URLSearchParams(Object.entries(params).flatMap(([k, v]) => (k === "ok" || k === "error" || v === undefined ? [] : [[k, one(v)]]))).toString()}`;

  const open = (
    <Button asChild variant={admin && connected ? "outline" : "default"}>
      <a href={overview.portalUrl} target="_blank" rel="noopener noreferrer">
        Open capitupindia.com/office <ExternalLink className="size-4" />
      </a>
    </Button>
  );

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Office portal"
        description={DESCRIPTIONS[tab]}
        actions={
          <>
            {admin && connected ? (
              <form action={refreshOfficeAction}>
                <input type="hidden" name="back" value={here} />
                <Button type="submit" variant="outline">
                  <RefreshCw className="size-4" /> Refresh
                </Button>
              </form>
            ) : null}
            {open}
          </>
        }
      />

      <ResultNote ok={one(params.ok) || undefined} error={one(params.error) || undefined} />

      {admin && connected ? <Tabs current={tab} overview={overview} /> : null}

      {overview.state === "not-configured" ? (
        <Panel title="The office portal is not connected yet" icon={Sparkles} className="mb-6">
          <p className="text-sm text-muted-foreground">
            {admin
              ? "To work call requests, renewals and gap reports here, add the office account the LMS signs in with as Worker secrets OFFICE_EMAIL and OFFICE_PASSWORD (see docs/office-portal.md). Until then, use the button above."
              : "Use the button above to open the portal. Clients that admins hand to you appear in your Leads."}
          </p>
        </Panel>
      ) : null}

      {overview.state === "error" && tab === "overview" ? (
        <Panel title="Could not read the office portal" icon={ShieldAlert} className="mb-6">
          <p className="text-sm text-muted-foreground">{overview.message} You can still open the portal with the button above.</p>
        </Panel>
      ) : null}

      {tab === "overview" ? <Overview data={overview} admin={admin} /> : null}
      {tab === "requests" ? <RequestsTab params={params} /> : null}
      {tab === "renewals" ? <RenewalsTab params={params} /> : null}
      {tab === "policies" ? <PoliciesTab params={params} /> : null}
      {tab === "games" ? <GamesTab params={params} /> : null}

      {overview.fetchedAt && tab === "overview" ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Read from the office portal at {fetchedFormat.format(new Date(overview.fetchedAt))} IST. Numbers refresh every 5 minutes.
          {admin ? "" : " Clients that admins hand to you appear in your Leads."}
        </p>
      ) : null}
    </>
  );
}

function Tabs({ current, overview }: { current: TabId; overview: OfficeOverview }) {
  const waiting = overview.stats?.leads.by_status.new ?? 0;
  const due = overview.stats?.renewals_due ?? 0;
  return (
    <nav aria-label="Office sections" className="mb-5 flex gap-1 overflow-x-auto border-b">
      {TABS.map((t) => {
        const Icon = t.icon;
        const badge = t.id === "requests" ? waiting : t.id === "renewals" ? due : 0;
        return (
          <Link
            key={t.id}
            href={t.id === "overview" ? "/office" : `/office?tab=${t.id}`}
            aria-current={current === t.id ? "page" : undefined}
            className={cn(
              "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
              current === t.id ? "border-brand-600 font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {t.label}
            {badge ? (
              <span className={cn("rounded-full px-1.5 text-[11px] font-semibold text-white", t.id === "renewals" ? "bg-amber-500" : "bg-brand-600")}>
                {badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

function Overview({ data, admin }: { data: OfficeOverview; admin: boolean }) {
  const stats = data.stats;
  if (!stats) return null;
  const waiting = stats.leads.by_status.new ?? 0;
  return (
    <>
      <div className="stagger mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Waiting for a call"
          value={waiting}
          hint={waiting ? "Nobody has handled these yet" : "Everyone has been contacted"}
          icon={PhoneCall}
          tone="urgent"
          quiet={waiting === 0}
          href={admin ? "/office?tab=requests&filter=new" : undefined}
        />
        <StatCard
          label="Call requests"
          value={stats.leads.total}
          hint={trend(stats.leads.week, stats.leads.previous_week)}
          icon={PhoneCall}
          tone="brand"
          href={admin ? "/office?tab=requests" : undefined}
        />
        <StatCard
          label="Renewals due in 30 days"
          value={stats.renewals_due}
          hint="Not yet contacted"
          icon={AlarmClock}
          tone="warning"
          quiet={stats.renewals_due === 0}
          href={admin ? "/office?tab=renewals" : undefined}
        />
        <StatCard
          label="Policies uploaded"
          value={stats.policies.total}
          hint={trend(stats.policies.week, stats.policies.previous_week)}
          icon={FileText}
          tone="brand"
          href={admin ? "/office?tab=policies" : undefined}
        />
        <StatCard
          label="Reports with a high gap"
          value={stats.gaps.reports_with_high}
          hint={`of ${formatCount(stats.reports)} gap reports`}
          icon={ShieldAlert}
          tone="warning"
          quiet={stats.gaps.reports_with_high === 0}
        />
        <StatCard label="Protection games saved" value={stats.games} icon={Gamepad2} href={admin ? "/office?tab=games" : undefined} />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        {admin ? (
          <Panel
            title="Latest call requests"
            icon={PhoneCall}
            className="lg:col-span-2"
            actions={<Link className="text-xs text-brand-700 hover:underline" href="/office?tab=requests">See all →</Link>}
          >
            {stats.recent_leads?.length ? (
              <ul className="flex flex-col">
                {stats.recent_leads.map((lead) => {
                  const s = leadStep(lead.status);
                  return (
                    <li key={lead.id}>
                      <Link href={requestsHref({ id: lead.id, filter: "all" })} className="flex items-center gap-2.5 rounded-md px-2 py-2 hover:bg-muted">
                        <Initials name={lead.name} tone={s.tone} />
                        <span className="min-w-0 flex-1">
                          <strong className="block truncate text-sm">{lead.name}</strong>
                          <small className="text-xs text-muted-foreground">
                            {officeAgo(lead.created_at)} · {OFFICE_SOURCE[lead.source] ?? "Website"}
                          </small>
                        </span>
                        <Tag tone={s.tone}>{s.label}</Tag>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty>No call requests yet. They appear here as soon as a client asks for a call.</Empty>
            )}
          </Panel>
        ) : null}
        <Panel title="Call requests by status" icon={PhoneCall}>
          <BarList data={bars(stats.leads.by_status, LEAD_LABELS)} />
        </Panel>
        <Panel title="Last 30 days" description="From visit to call request" icon={Users}>
          <BarList
            data={[
              { label: "Visitors", value: stats.funnel.visitors, valueLabel: formatCount(stats.funnel.visitors) },
              { label: "Policies uploaded", value: stats.funnel.policies, valueLabel: formatCount(stats.funnel.policies) },
              { label: "Gap reports", value: stats.funnel.reports, valueLabel: formatCount(stats.funnel.reports) },
              { label: "Call requests", value: stats.funnel.leads, valueLabel: formatCount(stats.funnel.leads) },
            ]}
          />
        </Panel>
        <Panel title="Policies by type" icon={FileText}>
          <BarList data={bars(stats.policies.by_type, OFFICE_TYPE)} />
        </Panel>
        <Panel title="What clients' policies are missing" description="Gap levels across the latest 500 reports" icon={ShieldAlert}>
          <BarList
            data={[
              { label: "High priority", value: stats.gaps.levels.HIGH ?? 0, colorClass: "bg-rose-500" },
              { label: "Medium", value: stats.gaps.levels.MEDIUM ?? 0, colorClass: "bg-amber-500" },
              { label: "Low", value: stats.gaps.levels.LOW ?? 0, colorClass: "bg-sky-500" },
              { label: "Fine as it is", value: stats.gaps.levels.OK ?? 0, colorClass: "bg-emerald-500" },
            ]}
          />
        </Panel>
        <Panel title="Where call requests come from" icon={Sparkles}>
          <BarList data={bars(stats.leads.by_source, OFFICE_SOURCE)} />
        </Panel>
      </div>
    </>
  );
}

type Params = Record<string, string | string[] | undefined>;

async function RequestsTab({ params }: { params: Params }) {
  const filters = ["open", "all", ...OFFICE_LEAD_STEPS.map((s) => s.id)];
  const query: RequestsQuery = {
    id: one(params.id) || undefined,
    filter: filters.includes(one(params.filter)) ? one(params.filter) : "open",
    q: one(params.q).slice(0, 100),
    cursor: one(params.cursor) || undefined,
    report: one(params.report) || undefined,
  };
  const [page, detail, report, team] = await Promise.all([
    attempt(() => getCallRequests(query.cursor)),
    query.id ? attempt(() => getCallRequest(query.id!)) : null,
    query.report ? attempt(() => getOfficeReport(query.report!)) : null,
    getTeam(),
  ]);
  if ("error" in page) return <Empty>{page.error}</Empty>;
  return (
    <CallRequests
      page={page.value}
      query={query}
      detail={detail && "value" in detail ? detail.value : null}
      detailError={detail && "error" in detail ? detail.error : undefined}
      report={report && "value" in report ? report.value : null}
      agents={team.filter((m) => m.is_active).map(({ id, full_name }) => ({ id, full_name }))}
    />
  );
}

async function RenewalsTab({ params }: { params: Params }) {
  const query: RenewalsQuery = {
    range: ["7", "30", "90", "expired"].includes(one(params.range)) ? one(params.range) : "30",
    type: ["health", "motor", "life"].includes(one(params.type)) ? one(params.type) : "all",
    contact: one(params.contact) === "1",
    q: one(params.q).slice(0, 100),
  };
  const items = await attempt(() => getOfficeRenewals());
  if ("error" in items) return <Empty>{items.error}</Empty>;
  return <Renewals items={items.value} query={query} />;
}

async function PoliciesTab({ params }: { params: Params }) {
  const query: PoliciesQuery = {
    id: one(params.id) || undefined,
    q: one(params.q).slice(0, 100),
    type: ["health", "motor", "life", "unsure"].includes(one(params.type)) ? one(params.type) : "all",
    cursor: one(params.cursor) || undefined,
  };
  if (query.id) {
    const policy = await attempt(() => getOfficePolicy(query.id!));
    if ("error" in policy) return <Empty>{policy.error}</Empty>;
    const report = await attempt(() => getOfficeReport(policy.value.conversation_id));
    return <PolicyDetail policy={policy.value} report={"value" in report ? report.value : null} query={query} />;
  }
  const page = await attempt(() => getOfficePolicies(query.cursor));
  if ("error" in page) return <Empty>{page.error}</Empty>;
  return <Policies page={page.value} query={query} />;
}

async function GamesTab({ params }: { params: Params }) {
  const cursor = one(params.cursor) || undefined;
  const page = await attempt(() => getOfficeGames(cursor));
  if ("error" in page) return <Empty>{page.error}</Empty>;
  return <Games page={page.value} cursor={cursor} />;
}
