import Link from "next/link";
import { Download, FileText, Mail, MessageCircle, Phone, Search, UserPlus } from "lucide-react";

import { handOffAction, updateCallRequestAction } from "@/app/(app)/office/actions";
import { Panel } from "@/components/analytics/charts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { CallRequestDetail, CallRequestPage, OfficeReport } from "@/lib/office";
import {
  OFFICE_CONSENT,
  OFFICE_LEAD_STEPS,
  OFFICE_METHOD,
  OFFICE_SOURCE,
  leadStep,
  officeAgo,
  officeType,
  officeWhen,
  policyStatus,
  reportMessage,
  rupees,
  whatsappLink,
} from "@/lib/office-labels";
import { cn } from "@/lib/utils";

import { Empty, GapChips, Initials, Tag } from "./office-bits";
import { ReportView } from "./report-view";

export type RequestsQuery = { id?: string; filter: string; q: string; cursor?: string; report?: string };

export function requestsHref(query: Partial<RequestsQuery>): string {
  const params = new URLSearchParams({ tab: "requests" });
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  if (params.get("filter") === "open") params.delete("filter");
  return `/office?${params.toString()}`;
}

const OPEN = ["new", "contacted", "follow_up"];

export function CallRequests({
  page,
  query,
  detail,
  report,
  agents,
  detailError,
}: {
  page: CallRequestPage;
  query: RequestsQuery;
  detail: CallRequestDetail | null;
  report: OfficeReport | null;
  agents: { id: string; full_name: string }[];
  detailError?: string;
}) {
  const counts = Object.fromEntries(OFFICE_LEAD_STEPS.map((s) => [s.id, page.items.filter((r) => r.status === s.id).length]));
  const q = query.q.toLowerCase();
  const shown = page.items.filter((r) => {
    const okStatus = query.filter === "all" || (query.filter === "open" ? OPEN.includes(r.status) : r.status === query.filter);
    return okStatus && (!q || [r.name, r.phone, r.email, r.message].some((v) => String(v ?? "").toLowerCase().includes(q)));
  });
  const chips: [string, string, number][] = [
    ["open", "Open", OPEN.reduce((n, s) => n + (counts[s] ?? 0), 0)],
    ...OFFICE_LEAD_STEPS.map((s) => [s.id, s.label, counts[s.id] ?? 0] as [string, string, number]),
    ["all", "All", page.items.length],
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside aria-label="Call requests" className="surface flex flex-col gap-3 p-3">
        <form action="/office" className="flex gap-2">
          <input type="hidden" name="tab" value="requests" />
          {query.filter !== "open" ? <input type="hidden" name="filter" value={query.filter} /> : null}
          {query.cursor ? <input type="hidden" name="cursor" value={query.cursor} /> : null}
          <label className="relative flex-1">
            <span className="sr-only">Search call requests</span>
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input name="q" defaultValue={query.q} placeholder="Name, phone, email" className="pl-8" />
          </label>
        </form>
        <div className="flex flex-wrap gap-1.5">
          {chips.map(([id, label, n]) => (
            <Link
              key={id}
              href={requestsHref({ ...query, id: undefined, report: undefined, filter: id })}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs",
                query.filter === id ? "border-brand-600 bg-brand-600 text-white" : "hover:bg-muted",
              )}
            >
              {label} <span className="opacity-70">{n}</span>
            </Link>
          ))}
        </div>
        {shown.length ? (
          <ul className="-mx-1 flex flex-col">
            {shown.map((r) => {
              const s = leadStep(r.status);
              const handed = page.handoffs[r.id];
              return (
                <li key={r.id}>
                  <Link
                    href={requestsHref({ ...query, id: r.id, report: undefined })}
                    aria-current={detail?.lead.id === r.id ? "page" : undefined}
                    className={cn("flex items-center gap-2.5 rounded-md px-2 py-2 hover:bg-muted", detail?.lead.id === r.id && "bg-muted")}
                  >
                    <Initials name={r.name} tone={s.tone} />
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm">{r.name || "—"}</strong>
                      <small className="block truncate text-xs text-muted-foreground">
                        {officeAgo(r.created_at)}
                        {r.phone ? ` · ${r.phone}` : ""}
                        {handed ? ` · LMS #${handed.leadId}` : ""}
                      </small>
                    </span>
                    <Tag tone={s.tone}>{s.label}</Tag>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>{query.q || query.filter !== "all" ? "No call requests match." : "No call requests yet."}</Empty>
        )}
        <div className="flex justify-between gap-2 text-xs">
          {query.cursor ? <Link className="text-brand-700 hover:underline" href={requestsHref({ filter: query.filter, q: query.q })}>← Newest</Link> : <span />}
          {page.next_cursor ? (
            <Link className="text-brand-700 hover:underline" href={requestsHref({ filter: query.filter, q: query.q, cursor: page.next_cursor })}>
              Older requests →
            </Link>
          ) : null}
        </div>
        <p className="text-[11px] text-muted-foreground">Search and filters apply to the 100 requests on this page.</p>
      </aside>

      <div className="min-w-0">
        {detail ? (
          <ClientPage detail={detail} query={query} report={report} agents={agents} />
        ) : detailError ? (
          <Empty>{detailError}</Empty>
        ) : (
          <Empty>Pick a call request to see the client, their policies and reports, and to record follow-up.</Empty>
        )}
      </div>
    </div>
  );
}

function ClientPage({
  detail,
  query,
  report,
  agents,
}: {
  detail: CallRequestDetail;
  query: RequestsQuery;
  report: OfficeReport | null;
  agents: { id: string; full_name: string }[];
}) {
  const { lead } = detail;
  const s = leadStep(lead.status);
  const wa = whatsappLink(lead.phone);
  const back = requestsHref({ ...query, id: lead.id });

  return (
    <article className="flex flex-col gap-4">
      <header className="surface flex flex-wrap items-center gap-3 p-4">
        <Initials name={lead.name} tone={s.tone} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{lead.name || "—"}</h2>
          <p className="text-xs text-muted-foreground">
            Asked for a call {officeAgo(lead.created_at)} · {officeWhen(lead.created_at)} · via {OFFICE_SOURCE[lead.source] ?? "the website"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {lead.phone ? (
            <Button asChild size="sm">
              <a href={`tel:${lead.phone}`}><Phone className="size-4" /> Call {lead.phone}</a>
            </Button>
          ) : null}
          {wa ? (
            <Button asChild size="sm" variant="outline">
              <a href={lead.source === "whatsapp" ? `${wa}?text=${encodeURIComponent(reportMessage(lead.name))}` : wa} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="size-4" /> {lead.source === "whatsapp" ? "Send report on WhatsApp" : "WhatsApp"}
              </a>
            </Button>
          ) : null}
          {lead.email ? (
            <Button asChild size="sm" variant="outline">
              <a href={`mailto:${lead.email}`}><Mail className="size-4" /> Email</a>
            </Button>
          ) : null}
        </div>
      </header>

      <Panel
        title="Follow-up status"
        description={lead.status_changed_at ? `Updated ${officeAgo(lead.status_changed_at)}${lead.handled_by ? ` by ${lead.handled_by}` : ""}` : s.hint}
      >
        <form action={updateCallRequestAction} className="flex flex-wrap gap-2" aria-label="Follow-up status">
          <input type="hidden" name="id" value={lead.id} />
          <input type="hidden" name="back" value={back} />
          {OFFICE_LEAD_STEPS.map((step) => (
            <Button
              key={step.id}
              type="submit"
              name="status"
              value={step.id}
              size="sm"
              variant={lead.status === step.id ? "default" : "outline"}
              aria-pressed={lead.status === step.id}
              disabled={lead.status === step.id}
              title={step.hint}
            >
              {step.label}
            </Button>
          ))}
        </form>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Contact details">
          <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Phone</dt>
            <dd>{lead.phone ? <a className="hover:underline" href={`tel:${lead.phone}`}>{lead.phone}</a> : "—"}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd className="break-all">{lead.email ? <a className="hover:underline" href={`mailto:${lead.email}`}>{lead.email}</a> : "—"}</dd>
            <dt className="text-muted-foreground">Best time</dt>
            <dd>{[lead.preferred_time, lead.timezone].filter(Boolean).join(" · ") || "—"}</dd>
            <dt className="text-muted-foreground">Marketing</dt>
            <dd>{lead.marketing_opt_in ? "Agreed to receive updates" : "Contact only about this request"}</dd>
          </dl>
          <h3 className="mt-4 text-xs font-medium text-muted-foreground">What they want to discuss</h3>
          <p className="mt-1 text-sm whitespace-pre-line">{lead.message || "—"}</p>
        </Panel>

        <Panel title="Team notes" description="Saved in the office portal; visible to the Capitup team only.">
          <form action={updateCallRequestAction} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={lead.id} />
            <input type="hidden" name="back" value={back} />
            <Textarea name="notes" defaultValue={lead.notes} maxLength={4000} rows={6} placeholder="What was discussed, quotes sent, next call date…" />
            <div className="flex justify-end">
              <Button type="submit" size="sm">Save notes</Button>
            </div>
          </form>
        </Panel>
      </div>

      <Panel title="Hand to an agent" icon={UserPlus} description="Makes this client an LMS lead the agent works like any other: POCs, notes, status and renewal reminders.">
        {detail.handoff ? (
          <p className="text-sm">
            Already{" "}
            <Link className="font-medium text-brand-700 hover:underline" href={`/leads/${detail.handoff.leadId}`}>
              LMS lead #{detail.handoff.leadId}
            </Link>
            , {detail.handoff.agentName ? `assigned to ${detail.handoff.agentName}` : "unassigned"}.
          </p>
        ) : (
          <form action={handOffAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="id" value={lead.id} />
            <input type="hidden" name="back" value={back} />
            <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs text-muted-foreground">
              Agent
              <NativeSelect name="agent" defaultValue="">
                <option value="">Unassigned (pick later)</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.full_name}</option>
                ))}
              </NativeSelect>
            </label>
            <Button type="submit">Create LMS lead</Button>
          </form>
        )}
      </Panel>

      <Panel title={`Policies from this client (${detail.policies.length})`} icon={FileText}>
        {detail.policies.length ? (
          <ul className="flex flex-col divide-y">
            {detail.policies.map((p) => {
              const [label, tone] = policyStatus(p.status);
              const open = query.report === p.conversation_id;
              return (
                <li key={p.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1 basis-64">
                      <strong className="block text-sm break-all">{p.filename}</strong>
                      <small className="text-xs text-muted-foreground">
                        {officeType(p.policy_type)} · {p.pages || "—"} pages · {OFFICE_METHOD[p.extraction_method ?? ""] ?? "—"} · uploaded {officeWhen(p.created_at)}
                        {p.expires_on ? ` · ends ${p.expires_on}` : ""}
                      </small>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Tag tone={tone}>{label}</Tag>
                        <GapChips gaps={p.gaps} />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {p.report_at ? (
                        <Button asChild size="sm" variant="outline">
                          <Link href={requestsHref({ ...query, id: lead.id, report: open ? undefined : p.conversation_id })} scroll={false}>
                            {open ? "Hide report" : "View report"}
                          </Link>
                        </Button>
                      ) : null}
                      <Button asChild size="sm" variant="outline">
                        <a href={`/office/policies/${p.id}/download`}><Download className="size-4" /> Download</a>
                      </Button>
                    </div>
                  </div>
                  {open ? <ReportPanel report={report} /> : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>This client did not upload a policy with this request.</Empty>
        )}
      </Panel>

      {detail.other_requests.length || detail.games.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {detail.other_requests.length ? (
            <Panel title="Earlier requests">
              <ul className="flex flex-col gap-2 text-sm">
                {detail.other_requests.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2">
                    <Link className="hover:underline" href={requestsHref({ ...query, id: r.id, report: undefined })}>{officeWhen(r.created_at)}</Link>
                    <Tag tone={leadStep(r.status).tone}>{leadStep(r.status).label}</Tag>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
          {detail.games.length ? (
            <Panel title="Saved protection game">
              <ul className="flex flex-col gap-2 text-sm">
                {detail.games.map((g) => (
                  <li key={g.id} className="flex items-center justify-between gap-2">
                    <span>{officeWhen(g.created_at)}</span>
                    <span>Example bill in 5 years: {rupees(g.result?.inflated_bill)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function ReportPanel({ report }: { report: OfficeReport | null }) {
  if (!report) return <p className="mt-3 text-sm text-muted-foreground">The report could not be loaded.</p>;
  return (
    <div className="mt-3 rounded-md border bg-background p-4">
      {report.report ? (
        <>
          <p className="text-xs text-muted-foreground">Shown to the client on {officeWhen(report.report.created_at)}</p>
          <ReportView content={report.report.content} />
        </>
      ) : (
        <Empty>No report was produced for this policy.</Empty>
      )}
      {report.consents.length ? (
        <div className="mt-4 border-t pt-3">
          <h4 className="text-xs font-medium text-muted-foreground">Permissions the client gave</h4>
          <ul className="mt-2 flex flex-col gap-1.5 text-sm">
            {report.consents.map((c, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <Tag tone={c.accepted ? "good" : "warn"}>{c.accepted ? "Agreed" : "Withdrawn"}</Tag>
                <span>{OFFICE_CONSENT[c.purpose] ?? "Permission"}</span>
                <small className="text-xs text-muted-foreground">{officeWhen(c.created_at)}</small>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
