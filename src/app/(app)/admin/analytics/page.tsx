import type { Metadata } from "next";

import { PageHeader } from "@/components/app-shell/page-header";
import {
  AlarmClock,
  BarChart3,
  CalendarClock,
  CalendarRange,
  FilePlus2,
  Layers,
  PieChart,
  Shapes,
  Target,
  Trophy,
  Users,
  Building2,
} from "lucide-react";

import { BarList, Donut, MonthBars, Panel, StatCard } from "@/components/analytics/charts";
import { requireAdmin } from "@/lib/auth";
import { formatCount, getPipelineAnalytics } from "@/lib/analytics";
import type { LeadStatus, PolicyProduct } from "@/lib/database.types";
import { BUSINESS_TYPES, LEAD_STATUSES, LEAD_TYPES, POLICY_PRODUCTS, STATUS_COLORS } from "@/lib/domain";
import { leadsHref } from "@/lib/lead-filters";

export const metadata: Metadata = { title: "Analytics" };

const STATUS_BAR: Record<LeadStatus, string> = {
  Prospect: "bg-slate-400",
  Quoted: "bg-sky-500",
  "Active Client": "bg-brand-500",
  "Follow-up": "bg-amber-500",
  "Closed Won": "bg-green-600",
  "Closed Lost": "bg-rose-500",
};

function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;
}

export default async function AnalyticsPage() {
  await requireAdmin();
  const data = await getPipelineAnalytics();

  const status = (s: LeadStatus) => data.by_status[s] ?? 0;
  const won = status("Closed Won");
  const lost = status("Closed Lost");
  const closed = won + lost;
  const quotedEver = won + lost + status("Quoted");

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Analytics"
        description="Pipeline, renewals and agent performance, computed live from the leads in the CRM."
      />

      <div className="stagger mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Leads" value={data.total} href={leadsHref({})} icon={Layers} tone="brand" />
        <StatCard
          label="Renewals overdue"
          value={data.renewals.overdue}
          icon={AlarmClock}
          tone="urgent"
          quiet={data.renewals.overdue === 0}
          href={leadsHref({ renewal: "overdue", sort: "renewal_desc" })}
        />
        <StatCard
          label="Renewals this week"
          value={data.renewals.week}
          icon={CalendarClock}
          tone="warning"
          href={leadsHref({ renewal: "7", sort: "renewal_asc" })}
        />
        <StatCard label="Renewals in 30 days" value={data.renewals.month} icon={CalendarRange} tone="gold" href={leadsHref({ renewal: "30", sort: "renewal_asc" })} />
        <StatCard
          label="Win rate"
          value={percent(won, closed)}
          hint={`${formatCount(won)} won of ${formatCount(closed)} closed`}
          icon={Trophy}
          tone="success"
        />
        <StatCard
          label="Quote conversion"
          value={percent(won, quotedEver)}
          hint={`${formatCount(won)} of ${formatCount(quotedEver)} quoted`}
          icon={Target}
          tone="brand"
        />
      </div>

      <div className="stagger grid gap-6 lg:grid-cols-2">
        <Panel title="Pipeline by status" icon={PieChart}>
          <Donut
            centerValue={data.total}
            centerLabel="leads"
            data={LEAD_STATUSES.map((s) => ({ label: s, value: status(s), color: STATUS_COLORS[s], href: leadsHref({ status: s }) }))}
          />
          <div className="mt-5 border-t pt-4">
            <BarList
              data={LEAD_STATUSES.map((s) => ({
                label: s,
                value: status(s),
                href: leadsHref({ status: s }),
                colorClass: STATUS_BAR[s],
              }))}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              {formatCount(data.unassigned)} unassigned · {formatCount(data.duplicates)} flagged as duplicates
            </p>
          </div>
        </Panel>

        <Panel title="Products" icon={Shapes}>
          <BarList
            data={POLICY_PRODUCTS.map((p: PolicyProduct) => ({
              label: p,
              value: data.by_product[p] ?? 0,
              href: leadsHref({ product: p }),
            })).filter((d) => d.value > 0)}
          />
        </Panel>

        <Panel title="Renewals by month" description="Open leads with a renewal date in the next 12 months" icon={CalendarRange}>
          <MonthBars data={data.renewals_by_month} colorClass="bg-gradient-to-t from-gold-600 to-gold-300" />
        </Panel>

        <Panel title="Leads created" description="Last six months" icon={FilePlus2}>
          <MonthBars data={data.created_by_month} />
        </Panel>

        <Panel title="New vs renewal" icon={BarChart3}>
          <BarList
            data={LEAD_TYPES.map((t) => ({ label: t, value: data.by_type[t] ?? 0, href: leadsHref({ type: t }) }))}
          />
        </Panel>

        <Panel title="Corporate vs retail" icon={Building2}>
          <BarList
            data={BUSINESS_TYPES.map((t) => ({
              label: t,
              value: data.by_business[t] ?? 0,
              colorClass: "bg-gradient-to-r from-gold-500 to-gold-300",
            }))}
          />
        </Panel>
      </div>

      <Panel title="Agent performance" icon={Users} className="mt-6">
        {data.agents.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">No leads yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="text-left text-[11px] tracking-wide text-muted-foreground uppercase">
                <tr className="border-b">
                  <th className="py-2 pr-3">Agent</th>
                  <th className="px-3 py-2 text-right">Leads</th>
                  <th className="px-3 py-2 text-right">Follow-ups</th>
                  <th className="px-3 py-2 text-right">Quoted</th>
                  <th className="px-3 py-2 text-right">Active</th>
                  <th className="px-3 py-2 text-right">Won</th>
                  <th className="px-3 py-2 text-right">Win rate</th>
                  <th className="px-3 py-2 text-right">Renewals 30d</th>
                  <th className="py-2 pl-3 text-right">Overdue</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.agents.map((agent) => (
                  <tr key={agent.agent_id ?? "unassigned"} className="transition-colors hover:bg-muted/50">
                    <td className="py-2 pr-3 font-medium">
                      {agent.agent_id ? (
                        <a href={leadsHref({ agent: agent.agent_id })} className="hover:text-primary hover:underline">
                          {agent.agent_name}
                        </a>
                      ) : (
                        <a href={leadsHref({ agent: "unassigned" })} className="text-muted-foreground hover:underline">
                          Unassigned
                        </a>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCount(agent.total)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCount(agent.follow_up)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCount(agent.quoted)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCount(agent.active_client)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCount(agent.won)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{percent(agent.won, agent.won + agent.lost)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCount(agent.renewals_30d)}</td>
                    <td
                      className={`py-2 pl-3 text-right tabular-nums${agent.overdue_renewals > 0 ? " font-semibold text-urgent" : ""}`}
                    >
                      {formatCount(agent.overdue_renewals)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

    </>
  );
}
