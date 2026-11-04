import type { Metadata } from "next";
import {
  AlarmClock,
  CalendarClock,
  ExternalLink,
  FileText,
  Gamepad2,
  PhoneCall,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Users,
} from "lucide-react";

import { BarList, Panel, StatCard } from "@/components/analytics/charts";
import { PageHeader } from "@/components/app-shell/page-header";
import { Button } from "@/components/ui/button";
import { formatCount } from "@/lib/analytics";
import { getOfficeOverview } from "@/lib/office";
import { isAdmin, requireProfile } from "@/lib/auth";

import { refreshOfficeAction } from "./actions";

export const metadata: Metadata = { title: "Office portal" };

const TYPE_LABELS: Record<string, string> = { health: "Health", motor: "Motor", life: "Life", unsure: "Not sure" };
const RENEWAL_LABELS: Record<string, string> = {
  to_contact: "To contact",
  contacted: "Contacted",
  quoted: "Quoted",
  renewed: "Renewed",
  lost: "Lost",
};

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

export default async function OfficePage() {
  const [profile, data] = await Promise.all([requireProfile(), getOfficeOverview()]);
  const admin = isAdmin(profile);
  const stats = data.stats;

  const open = (
    <Button asChild>
      <a href={data.portalUrl} target="_blank" rel="noopener noreferrer">
        Open office portal <ExternalLink className="size-4" />
      </a>
    </Button>
  );

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Office portal"
        description="Policies, gap reports and call requests from Capitup AI on capitupindia.com. Sign in there with your office account to work on a client."
        actions={
          <>
            {admin && data.state !== "not-configured" ? (
              <form action={refreshOfficeAction}>
                <Button type="submit" variant="outline">
                  <RefreshCw className="size-4" /> Refresh
                </Button>
              </form>
            ) : null}
            {open}
          </>
        }
      />

      {data.state === "not-configured" ? (
        <Panel title="Live office numbers are not switched on yet" icon={Sparkles}>
          <p className="text-sm text-muted-foreground">
            Use the button above to open the portal and sign in. To show its policies and stats here, an admin adds the
            office account the LMS should read with (Worker secrets <code>OFFICE_EMAIL</code> and{" "}
            <code>OFFICE_PASSWORD</code>).
          </p>
        </Panel>
      ) : null}

      {data.state === "error" ? (
        <Panel title="Could not read the office portal" icon={ShieldAlert}>
          <p className="text-sm text-muted-foreground">{data.message} You can still open the portal with the button above.</p>
        </Panel>
      ) : null}

      {stats ? (
        <>
          <div className="stagger mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard
              label="Policies uploaded"
              value={stats.policies.total}
              hint={trend(stats.policies.week, stats.policies.previous_week)}
              icon={FileText}
              tone="brand"
            />
            <StatCard label="Gap reports" value={stats.reports} icon={Sparkles} tone="gold" />
            <StatCard
              label="Call requests"
              value={stats.leads.total}
              hint={trend(stats.leads.week, stats.leads.previous_week)}
              icon={PhoneCall}
              tone="brand"
            />
            <StatCard
              label="Renewals due in 30 days"
              value={stats.renewals_due}
              hint="Not yet contacted"
              icon={AlarmClock}
              tone="urgent"
              quiet={stats.renewals_due === 0}
            />
            <StatCard
              label="Reports with a high gap"
              value={stats.gaps.reports_with_high}
              icon={ShieldAlert}
              tone="warning"
              quiet={stats.gaps.reports_with_high === 0}
            />
            <StatCard label="Coverage games played" value={stats.games} icon={Gamepad2} />
          </div>

          <div className="mb-6 grid gap-4 lg:grid-cols-3">
            <Panel title="Policies by type" icon={FileText}>
              <BarList data={bars(stats.policies.by_type, TYPE_LABELS)} />
            </Panel>
            <Panel title="Call requests by status" icon={PhoneCall}>
              <BarList data={bars(stats.leads.by_status)} />
            </Panel>
            <Panel title="Last 30 days" description="Visitors to call requests" icon={Users}>
              <BarList
                data={[
                  { label: "Visitors", value: stats.funnel.visitors, valueLabel: formatCount(stats.funnel.visitors) },
                  { label: "Policies uploaded", value: stats.funnel.policies, valueLabel: formatCount(stats.funnel.policies) },
                  { label: "Gap reports", value: stats.funnel.reports, valueLabel: formatCount(stats.funnel.reports) },
                  { label: "Call requests", value: stats.funnel.leads, valueLabel: formatCount(stats.funnel.leads) },
                ]}
              />
            </Panel>
          </div>
        </>
      ) : null}

      {data.renewals ? (
        <Panel
          title="Client policy renewals"
          description="Policies ending between 30 days ago and 90 days ahead, from the office portal."
          icon={CalendarClock}
          bodyClassName="p-0"
        >
          {data.renewals.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">No policies are due for renewal in that window.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-5 py-2 font-medium">Client</th>
                    <th className="px-3 py-2 font-medium">Policy</th>
                    <th className="px-3 py-2 font-medium">Ends</th>
                    <th className="px-3 py-2 font-medium">Outreach</th>
                    <th className="px-5 py-2 font-medium">Gaps</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.renewals.map((r) => (
                    <tr key={r.id}>
                      <td className="px-5 py-2.5">
                        <div className="font-medium">{r.contact?.name || "No contact yet"}</div>
                        {r.contact?.phone ? (
                          <a href={`tel:${r.contact.phone}`} className="text-xs text-muted-foreground hover:underline">
                            {r.contact.phone}
                          </a>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5">
                        <div>{r.title || r.filename}</div>
                        <div className="text-xs text-muted-foreground">{label(TYPE_LABELS, r.policy_type ?? "unsure")}</div>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <div>{r.expires_on}</div>
                        <div className={r.days_left < 0 ? "text-xs text-rose-600" : r.days_left <= 30 ? "text-xs text-amber-600" : "text-xs text-muted-foreground"}>
                          {r.days_left < 0 ? `${-r.days_left} days ago` : r.days_left === 0 ? "Today" : `in ${r.days_left} days`}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">{label(RENEWAL_LABELS, r.renewal_status)}</td>
                      <td className="px-5 py-2.5 text-xs whitespace-nowrap">
                        {r.gaps ? Object.entries(r.gaps).filter(([level, n]) => n > 0 && level !== "OK").map(([level, n]) => `${n} ${level.toLowerCase()}`).join(", ") || "None" : "No report"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : null}

      {data.fetchedAt ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Read from the office portal at {fetchedFormat.format(new Date(data.fetchedAt))} IST. Numbers refresh every 5 minutes.
          {admin ? "" : " Client names and renewal dates are in the portal itself."}
        </p>
      ) : null}
    </>
  );
}
