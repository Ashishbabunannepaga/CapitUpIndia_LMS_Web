import Link from "next/link";
import { Download, Search } from "lucide-react";

import { Panel } from "@/components/analytics/charts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OfficeGame, OfficePage, OfficePolicy, OfficePolicyDetail, OfficeReport } from "@/lib/office";
import { OFFICE_METHOD, officeAgo, officeType, officeWhen, policyStatus, rupees } from "@/lib/office-labels";
import { cn } from "@/lib/utils";

import { ReportPanel } from "./call-requests";
import { Empty, Tag } from "./office-bits";

export type PoliciesQuery = { id?: string; q: string; type: string; cursor?: string };

export function policiesHref(query: Partial<PoliciesQuery>): string {
  const params = new URLSearchParams({ tab: "policies" });
  for (const [key, value] of Object.entries(query)) if (value && !(key === "type" && value === "all")) params.set(key, value);
  return `/office?${params.toString()}`;
}

export function Policies({ page, query }: { page: OfficePage<OfficePolicy>; query: PoliciesQuery }) {
  const q = query.q.toLowerCase();
  const shown = page.items.filter(
    (r) => (!q || r.filename.toLowerCase().includes(q)) && (query.type === "all" || (r.policy_type || "unsure") === query.type),
  );
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form action="/office">
          <input type="hidden" name="tab" value="policies" />
          {query.type !== "all" ? <input type="hidden" name="type" value={query.type} /> : null}
          {query.cursor ? <input type="hidden" name="cursor" value={query.cursor} /> : null}
          <label className="relative block">
            <span className="sr-only">Search by file name</span>
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input name="q" defaultValue={query.q} placeholder="Search by file name" className="w-60 pl-8" />
          </label>
        </form>
        <div className="flex flex-wrap gap-1.5">
          {["all", "health", "motor", "life", "unsure"].map((t) => (
            <Link
              key={t}
              href={policiesHref({ ...query, id: undefined, type: t })}
              className={cn("rounded-full border px-2.5 py-0.5 text-xs", query.type === t ? "border-brand-600 bg-brand-600 text-white" : "hover:bg-muted")}
            >
              {t === "all" ? "All" : officeType(t)}
            </Link>
          ))}
        </div>
        <span className="ml-auto text-xs text-muted-foreground">{shown.length} shown</span>
      </div>
      {shown.length ? (
        <div className="surface overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Policy file</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Pages</th>
                <th className="px-3 py-2 font-medium">Copy</th>
                <th className="px-4 py-2 font-medium">Uploaded</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {shown.map((r) => {
                const [label, tone] = policyStatus(r.status);
                return (
                  <tr key={r.id} className="hover:bg-muted/40">
                    <td className="px-4 py-2.5">
                      <Link className="font-medium break-all hover:underline" href={policiesHref({ ...query, id: r.id })}>{r.filename}</Link>
                    </td>
                    <td className="px-3 py-2.5">{officeType(r.policy_type)}</td>
                    <td className="px-3 py-2.5"><Tag tone={tone}>{label}</Tag></td>
                    <td className="px-3 py-2.5 tabular-nums">{r.pages || "—"}</td>
                    <td className="px-3 py-2.5">{OFFICE_METHOD[r.extraction_method ?? ""] ?? "—"}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap" title={officeWhen(r.created_at)}>{officeAgo(r.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>{query.q || query.type !== "all" ? "No policies match." : "No policies uploaded yet."}</Empty>
      )}
      <div className="mt-3 flex justify-between text-xs">
        {query.cursor ? <Link className="text-brand-700 hover:underline" href={policiesHref({ q: query.q, type: query.type })}>← Newest</Link> : <span />}
        {page.next_cursor ? (
          <Link className="text-brand-700 hover:underline" href={policiesHref({ q: query.q, type: query.type, cursor: page.next_cursor })}>Older uploads →</Link>
        ) : null}
      </div>
    </>
  );
}

export function PolicyDetail({ policy, report, query }: { policy: OfficePolicyDetail; report: OfficeReport | null; query: PoliciesQuery }) {
  const [label, tone] = policyStatus(policy.status);
  return (
    <article className="flex flex-col gap-4">
      <Link className="text-sm text-brand-700 hover:underline" href={policiesHref({ ...query, id: undefined })}>← All policies</Link>
      <header className="surface flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold break-all">{policy.filename}</h2>
          <p className="text-xs text-muted-foreground">{officeType(policy.policy_type)} policy · uploaded {officeWhen(policy.created_at)}</p>
        </div>
        <Button asChild>
          <a href={`/office/policies/${policy.id}/download`}><Download className="size-4" /> Download file</a>
        </Button>
      </header>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Fact label="Status"><Tag tone={tone}>{label}</Tag></Fact>
        <Fact label="Pages">{policy.pages || "—"}</Fact>
        <Fact label="Copy">{OFFICE_METHOD[policy.extraction_method ?? ""] ?? "—"}</Fact>
        <Fact label="Ends">{policy.expires_on ?? "—"}</Fact>
        {policy.ocr_pages ? (
          <Fact label="Scanned pages read">
            {policy.ocr_pages}
            {policy.ocr_confidence ? ` · ${Math.round(policy.ocr_confidence)}% clear` : ""}
          </Fact>
        ) : null}
      </div>
      {policy.status !== "extracted" && policy.message ? <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">{policy.message}</p> : null}
      <Panel title="Gap report shown to the client">
        <ReportPanel report={report} />
      </Panel>
    </article>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="surface p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm font-medium">{children}</div>
    </div>
  );
}

const WHO: Record<string, string> = { individual: "Individual", family: "Family", employee: "Employee", business: "Business" };
const SCENE: Record<string, string> = { health: "Health bill", income: "Income interruption", business: "Business disruption" };

export function Games({ page, cursor }: { page: OfficePage<OfficeGame>; cursor?: string }) {
  if (!page.items.length) {
    return <Empty>No saved game results yet. Visitors can play without saving; only results they choose to save appear here.</Empty>;
  }
  return (
    <>
      <div className="surface overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Saved</th>
              <th className="px-3 py-2 font-medium">Who</th>
              <th className="px-3 py-2 font-medium">Scenario</th>
              <th className="px-3 py-2 font-medium">Example bill in 5 years</th>
              <th className="px-4 py-2 font-medium">Savings buffer</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {page.items.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2.5 whitespace-nowrap">{officeWhen(r.created_at)}</td>
                <td className="px-3 py-2.5">{WHO[String(r.answers?.profile)] ?? "—"}</td>
                <td className="px-3 py-2.5">{SCENE[String(r.answers?.scenario)] ?? "—"}</td>
                <td className="px-3 py-2.5 tabular-nums">{rupees(r.result?.inflated_bill)}</td>
                <td className="px-4 py-2.5">{typeof r.result?.buffer_months === "number" ? `${r.result.buffer_months} months` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex justify-between text-xs">
        {cursor ? <Link className="text-brand-700 hover:underline" href="/office?tab=games">← Newest</Link> : <span />}
        {page.next_cursor ? (
          <Link className="text-brand-700 hover:underline" href={`/office?tab=games&cursor=${encodeURIComponent(page.next_cursor)}`}>Older results →</Link>
        ) : null}
      </div>
    </>
  );
}
