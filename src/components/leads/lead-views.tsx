import Link from "next/link";
import { Building2, Mail, Phone, User, UserX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { LeadWithAgent } from "@/lib/leads";
import { CLOSED_STATUSES } from "@/lib/domain";
import { cn } from "@/lib/utils";
import { DuplicateBadge, RenewalDate } from "./lead-badges";
import { StatusSelect } from "./status-select";

export function AgentName({ name }: { name: string | null }) {
  return name ? (
    <span className="whitespace-nowrap">{name}</span>
  ) : (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-warning">
      <UserX className="size-3.5" />
      Unassigned
    </span>
  );
}

function PocSummary({ lead }: { lead: LeadWithAgent }) {
  if (!lead.poc_name && !lead.poc_contact_number && !lead.poc_email_id) {
    return <span className="text-muted-foreground">No POC yet</span>;
  }
  return (
    <div className="min-w-0 leading-tight">
      <p className="truncate">
        {lead.poc_name || "Contact"}
        {lead.poc_designation && lead.poc_designation !== "poc" ? (
          <span className="text-muted-foreground"> · {lead.poc_designation}</span>
        ) : null}
        {lead.poc2_name ? <span className="text-xs text-muted-foreground"> +1</span> : null}
      </p>
      {lead.poc_contact_number ? (
        <p className="truncate text-xs text-muted-foreground">{lead.poc_contact_number}</p>
      ) : lead.poc_email_id ? (
        <p className="truncate text-xs text-muted-foreground">{lead.poc_email_id}</p>
      ) : null}
    </div>
  );
}

export function EmptyLeads({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-card p-10 text-center">
      <Building2 className="size-8 text-muted-foreground" />
      <p className="font-medium">{filtered ? "No leads match these filters." : "No leads yet."}</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {filtered ? "Clear a filter or search for something else." : "Add your first lead to start your pipeline."}
      </p>
    </div>
  );
}

export function LeadsTable({ leads, showAgent }: { leads: LeadWithAgent[]; showAgent: boolean }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="px-4 py-3">Client / company</th>
              <th className="px-4 py-3">Product</th>
              <th className="px-4 py-3">Primary POC</th>
              <th className="px-4 py-3">Renewal</th>
              <th className="px-4 py-3">Status</th>
              {showAgent ? <th className="px-4 py-3">Agent</th> : null}
              <th className="px-4 py-3">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {leads.map((lead) => (
              <tr
                key={lead.id}
                className={cn("align-top transition-colors hover:bg-muted/40", lead.is_duplicate && "bg-red-50/40")}
              >
                <td className="max-w-72 px-4 py-3">
                  <Link href={`/leads/${lead.id}`} className="font-medium text-foreground hover:text-primary hover:underline">
                    {lead.client_name}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{lead.type}</span>
                    <span aria-hidden>·</span>
                    <span>{lead.business_type}</span>
                    {lead.is_duplicate ? <DuplicateBadge label={lead.duplicate_label} /> : null}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <p className="whitespace-nowrap">{lead.policy_product}</p>
                  {lead.sub_product_name ? (
                    <p className="max-w-44 truncate text-xs text-muted-foreground">{lead.sub_product_name}</p>
                  ) : null}
                </td>
                <td className="max-w-56 px-4 py-3">
                  <PocSummary lead={lead} />
                </td>
                <td className="px-4 py-3">
                  <RenewalDate date={lead.renewal_date} closed={CLOSED_STATUSES.includes(lead.status)} compact />
                </td>
                <td className="px-4 py-3">
                  <StatusSelect leadId={lead.id} status={lead.status} />
                </td>
                {showAgent ? (
                  <td className="px-4 py-3">
                    <AgentName name={lead.agent_name} />
                  </td>
                ) : null}
                <td className="max-w-64 px-4 py-3">
                  <p className="line-clamp-2 text-xs text-muted-foreground">{lead.notes}</p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function LeadCards({ leads, showAgent }: { leads: LeadWithAgent[]; showAgent: boolean }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {leads.map((lead) => (
        <div
          key={lead.id}
          className={cn(
            "flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md",
            lead.is_duplicate && "border-red-200",
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <Link href={`/leads/${lead.id}`} className="line-clamp-2 font-semibold hover:text-primary hover:underline">
                {lead.client_name}
              </Link>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {lead.policy_product}
                {lead.sub_product_name ? ` · ${lead.sub_product_name}` : ""}
              </p>
            </div>
            <StatusSelect leadId={lead.id} status={lead.status} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{lead.type}</Badge>
            <Badge variant="secondary">{lead.business_type}</Badge>
            {lead.is_duplicate ? <DuplicateBadge label={lead.duplicate_label} /> : null}
          </div>
          <dl className="space-y-1.5 text-sm">
            <div className="flex items-center gap-2">
              <dt className="sr-only">Renewal</dt>
              <dd>
                <RenewalDate date={lead.renewal_date} closed={CLOSED_STATUSES.includes(lead.status)} />
              </dd>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <User className="size-3.5 shrink-0" />
              <dd className="truncate text-foreground">
                {lead.poc_name || "No POC yet"}
                {lead.poc_designation && lead.poc_designation !== "poc" && lead.poc_name ? (
                  <span className="text-muted-foreground"> · {lead.poc_designation}</span>
                ) : null}
              </dd>
            </div>
            {lead.poc_contact_number ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Phone className="size-3.5 shrink-0" />
                <dd className="truncate">{lead.poc_contact_number}</dd>
              </div>
            ) : null}
            {lead.poc_email_id ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Mail className="size-3.5 shrink-0" />
                <dd className="truncate">{lead.poc_email_id}</dd>
              </div>
            ) : null}
          </dl>
          {showAgent ? (
            <div className="mt-auto border-t pt-3 text-xs text-muted-foreground">
              Agent: <AgentName name={lead.agent_name} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
