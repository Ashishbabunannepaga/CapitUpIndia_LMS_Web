import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, FilePlus2, Pencil, Trash2 } from "lucide-react";

import { PageHeader } from "@/components/app-shell/page-header";
import { LeadLink } from "@/components/leads/lead-link";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { requireSession } from "@/lib/auth";
import { formatNoteTimestamp, startOfBusinessDay, addDays } from "@/lib/dates";
import { getTeam } from "@/lib/leads";
import { cn } from "@/lib/utils";
import { AUDIT_FIELDS, listLeadAudit, type AuditEntry, type AuditFilter } from "@/server/data/history";

export const metadata: Metadata = { title: "Audit log" };

const param = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";
const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const ACTIONS = {
  INSERT: { label: "Created", icon: FilePlus2, tone: "text-brand-700" },
  UPDATE: { label: "Edited", icon: Pencil, tone: "text-sky-700" },
  DELETE: { label: "Deleted", icon: Trash2, tone: "text-urgent" },
} as const;

function Changes({ entry }: { entry: AuditEntry }) {
  if (entry.changes.length === 0) return <span className="text-muted-foreground">-</span>;
  return (
    <ul className="space-y-1">
      {entry.changes.map((c) => (
        <li key={c.field} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-2 text-xs">
          <span className="text-muted-foreground">{c.label}</span>
          <span className="break-words">
            {entry.action === "UPDATE" ? (
              <>
                <span className="text-muted-foreground line-through">{c.from}</span> → {c.to}
              </>
            ) : entry.action === "INSERT" ? (
              c.to
            ) : (
              <span className="text-muted-foreground">{c.from}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

// Every create, edit and delete of a lead, with field-level old and new
// values. Read from audit_logs, which every lead write fills in the same D1
// batch. The admin layout requires an admin; listLeadAudit checks again.
export default async function AuditLogPage({ searchParams }: PageProps<"/admin/audit">) {
  const { ctx, actor } = await requireSession();
  const query = await searchParams;
  const team = await getTeam();
  const who = param(query.who);
  const field = param(query.field);
  const lead = param(query.lead);
  const from = param(query.from);
  const to = param(query.to);
  const page = Math.max(1, Number(param(query.page)) || 1);

  const filter: AuditFilter = { page };
  if (team.some((m) => m.id === who)) filter.actorId = who;
  if (Object.hasOwn(AUDIT_FIELDS, field)) filter.field = field;
  if (/^\d{1,12}$/.test(lead)) filter.leadId = Number(lead);
  if (isDate(from)) filter.from = startOfBusinessDay(from);
  if (isDate(to)) filter.to = startOfBusinessDay(addDays(to, 1));
  const { entries, hasMore } = await listLeadAudit(ctx, actor, filter);

  const href = (p: number, withLead = true) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ who, field, lead: withLead ? lead : "", from, to })) if (value) params.set(key, value);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/admin/audit?${qs}` : "/admin/audit";
  };

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Audit log"
        description="Every change to every lead: who made it, which field, the old and new value, and when. Newest first."
      />

      <form method="get" className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:flex lg:flex-wrap lg:items-end">
        <NativeSelect size="sm" name="who" aria-label="Changed by" defaultValue={who} className="lg:w-44">
          <option value="">Anyone</option>
          {team.map((m) => (
            <option key={m.id} value={m.id}>
              {m.full_name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect size="sm" name="field" aria-label="Field" defaultValue={field} className="lg:w-48">
          <option value="">Any field</option>
          {Object.entries(AUDIT_FIELDS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </NativeSelect>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          From
          <input type="date" name="from" defaultValue={from} className="h-8 rounded-md border bg-card px-2 text-sm text-foreground" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          To
          <input type="date" name="to" defaultValue={to} className="h-8 rounded-md border bg-card px-2 text-sm text-foreground" />
        </label>
        {lead ? <input type="hidden" name="lead" value={lead} /> : null}
        <Button type="submit" size="sm">
          Filter
        </Button>
        {who || field || lead || from || to ? (
          <Button asChild size="sm" variant="ghost">
            <Link href="/admin/audit">Clear</Link>
          </Button>
        ) : null}
      </form>
      {filter.leadId ? (
        <p className="mb-3 text-sm text-muted-foreground">
          Showing lead #{filter.leadId} only.{" "}
          <Link href={href(1, false)} className="text-primary hover:underline">
            Show all leads
          </Link>
        </p>
      ) : null}

      <div className="overflow-hidden rounded-2xl border bg-card shadow-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b bg-muted/50 text-left text-xs font-medium text-muted-foreground">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Who</th>
                <th className="px-4 py-3">Lead</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">What changed (old → new)</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No changes match these filters.
                  </td>
                </tr>
              ) : (
                entries.map((entry) => {
                  const action = ACTIONS[entry.action];
                  return (
                    <tr key={entry.id} className="align-top">
                      <td className="px-4 py-3 whitespace-nowrap tabular-nums">{formatNoteTimestamp(entry.at)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{entry.actor_name}</td>
                      <td className="max-w-56 px-4 py-3">
                        {entry.lead_exists ? (
                          <LeadLink href={`/leads/${entry.lead_id}`} className="font-medium hover:text-primary hover:underline">
                            {entry.lead_name}
                          </LeadLink>
                        ) : (
                          <span className="text-muted-foreground line-through">{entry.lead_name}</span>
                        )}
                        <Link href={`/admin/audit?lead=${entry.lead_id}`} className="block text-xs text-muted-foreground hover:text-primary">
                          All changes to this lead
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", action.tone)}>
                          <action.icon className="size-3.5" />
                          {action.label}
                        </span>
                      </td>
                      <td className="min-w-72 px-4 py-3">
                        <Changes entry={entry} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {page > 1 || hasMore ? (
        <nav aria-label="Pages" className="mt-4 flex items-center justify-between gap-2">
          {page > 1 ? (
            <Button asChild variant="outline" size="sm">
              <Link href={href(page - 1)} rel="prev">
                <ChevronLeft />
                Newer
              </Link>
            </Button>
          ) : (
            <span />
          )}
          <span className="text-xs text-muted-foreground tabular-nums">Page {page}</span>
          {hasMore ? (
            <Button asChild variant="outline" size="sm">
              <Link href={href(page + 1)} rel="next">
                Older
                <ChevronRight />
              </Link>
            </Button>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </>
  );
}
