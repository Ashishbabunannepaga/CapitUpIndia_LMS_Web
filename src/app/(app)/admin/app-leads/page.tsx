import type { Metadata } from "next";
import Link from "next/link";
import { Mail, Phone, PlugZap, RefreshCw, Smartphone } from "lucide-react";

import { Panel } from "@/components/analytics/charts";
import { PageHeader } from "@/components/app-shell/page-header";
import { Empty, Initials, ResultNote, Tag } from "@/components/office/office-bits";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { requireSession } from "@/lib/auth";
import { getTeam } from "@/lib/leads";
import { appLeadsFeed } from "@/server/appfeed/feed";
import { listAppLeads, type AppLeadRow } from "@/server/data/app-leads";

import { handOffAppLeadAction, refreshAppLeadsAction } from "./actions";

export const metadata: Metadata = { title: "App leads" };

const TYPE: Record<string, string> = { health: "Health", motor: "Motor", life: "Life", other: "Other" };

const fetchedFormat = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.slice(0, 300) ?? "";
}

function daysUntil(date: string | null | undefined): number | null {
  if (!date) return null;
  const today = new Date(new Date().toISOString().slice(0, 10)).getTime();
  return Math.round((new Date(date).getTime() - today) / 86_400_000);
}

// The admin layout already requires an admin; listAppLeads checks again.
export default async function AppLeadsPage({ searchParams }: PageProps<"/admin/app-leads">) {
  const params = await searchParams;
  const { ctx, actor } = await requireSession();
  const [view, team] = await Promise.all([listAppLeads(appLeadsFeed, ctx, actor), getTeam()]);
  const agents = team.filter((m) => m.is_active).map(({ id, full_name }) => ({ id, full_name }));

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="App leads"
        description="People using the CapitUp app who ticked “CapitUp may contact me”. Hand each one to an agent as an LMS lead. If they later turn it off, their lead is closed with a do-not-contact note."
        actions={
          view.state === "ok" ? (
            <form action={refreshAppLeadsAction}>
              <Button type="submit" variant="outline">
                <RefreshCw className="size-4" /> Read again
              </Button>
            </form>
          ) : null
        }
      />
      <ResultNote ok={one(params.ok) || undefined} error={one(params.error) || undefined} />

      {view.state === "not-configured" ? (
        <Panel title="Not connected yet" icon={PlugZap}>
          <p className="text-sm text-muted-foreground">
            Add two Worker secrets: <code>APP_API_URL</code> (the app server&apos;s API address, ending in <code>/api/v1</code>) and{" "}
            <code>APP_LEADS_TOKEN</code> (the same value as <code>LEADS_API_TOKEN</code> on the app server).
          </p>
        </Panel>
      ) : view.state === "error" ? (
        <Empty>{view.message}</Empty>
      ) : (
        <>
          <p className="mb-4 text-xs text-muted-foreground">
            {view.items.length} opted in, {view.items.filter((i) => !i.handoff).length} not yet handed over
            {view.withdrawn ? `, ${view.withdrawn} withdrew` : ""}. Read {fetchedFormat.format(new Date(view.fetchedAt))}.
          </p>
          {view.items.length ? (
            <ul className="flex flex-col gap-3">
              {view.items.map((item) => (
                <AppLeadCard key={item.app_user_id} item={item} agents={agents} />
              ))}
            </ul>
          ) : (
            <Empty>Nobody has opted in from the app yet.</Empty>
          )}
        </>
      )}
    </>
  );
}

function AppLeadCard({ item, agents }: { item: AppLeadRow; agents: { id: string; full_name: string }[] }) {
  const days = daysUntil(item.next_renewal_date);
  const policies = item.policies ?? [];
  return (
    <li>
      <Panel
        title={item.full_name || item.phone || "App user"}
        icon={Smartphone}
        actions={
          days === null ? (
            <Tag tone="muted">No renewal date yet</Tag>
          ) : (
            <Tag tone={days <= 15 ? "risk" : days <= 45 ? "warn" : "info"}>
              Renews {item.next_renewal_date} ({days < 0 ? `${-days} days ago` : `in ${days} days`})
            </Tag>
          )
        }
      >
        <div className="flex flex-wrap items-start gap-4">
          <Initials name={item.full_name} />
          <div className="min-w-0 flex-1 space-y-1 text-sm">
            <p className="flex flex-wrap gap-x-4 gap-y-1">
              {item.phone ? (
                <a className="inline-flex items-center gap-1 underline-offset-2 hover:underline" href={`tel:${item.phone}`}>
                  <Phone className="size-3.5" /> {item.phone}
                </a>
              ) : null}
              {item.email ? (
                <a className="inline-flex items-center gap-1 underline-offset-2 hover:underline" href={`mailto:${item.email}`}>
                  <Mail className="size-3.5" /> {item.email}
                </a>
              ) : null}
              {item.city || item.state ? <span className="text-muted-foreground">{[item.city, item.state].filter(Boolean).join(", ")}</span> : null}
            </p>
            <p className="text-xs text-muted-foreground">Opted in {String(item.contact_consent_at ?? "").slice(0, 10)}</p>
            {policies.length ? (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {policies.map((p, index) => (
                  <li key={index}>
                    <Tag tone={p.verified ? "accent" : "muted"}>
                      {TYPE[p.policy_type] ?? p.policy_type}: {[p.insurer, p.plan_name].filter(Boolean).join(", ") || "insurer not read"}
                      {p.end_date ? `, ends ${p.end_date}` : ""}
                    </Tag>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No policies added in the app yet.</p>
            )}
          </div>
          <div className="w-full sm:w-auto">
            {item.handoff ? (
              <p className="text-sm">
                <Link className="font-medium underline-offset-2 hover:underline" href={`/leads/${item.handoff.leadId}`}>
                  LMS lead #{item.handoff.leadId}
                </Link>
                , {item.handoff.agentName ? `assigned to ${item.handoff.agentName}` : "unassigned"}.
              </p>
            ) : (
              <form action={handOffAppLeadAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="id" value={item.app_user_id} />
                <label className="flex min-w-48 flex-col gap-1 text-xs text-muted-foreground">
                  Agent
                  <NativeSelect name="agent" defaultValue="">
                    <option value="">Unassigned (pick later)</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.full_name}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <Button type="submit">Create LMS lead</Button>
              </form>
            )}
          </div>
        </div>
      </Panel>
    </li>
  );
}
