import type { Metadata } from "next";
import Link from "next/link";
import { CopyCheck } from "lucide-react";

import { PageHeader } from "@/components/app-shell/page-header";
import { DuplicateBadge, StatusBadge } from "@/components/leads/lead-badges";
import {
  AssignAgentSelect,
  DeleteLeadButton,
  ResolveDuplicateButton,
} from "@/components/leads/lead-detail-actions";
import { formatDate, formatDateTime } from "@/lib/dates";
import { getTeam, withAgentNames, type LeadWithAgent } from "@/lib/leads";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Duplicates" };

// The admin layout already requires an admin; RLS gives admins every lead.
export default async function DuplicatesPage() {
  const supabase = await createClient();
  const { data: flagged, error } = await supabase
    .from("leads")
    .select("client_name_normalized")
    .eq("is_duplicate", true)
    .limit(500);
  if (error) throw error;

  const names = [...new Set(flagged.map((l) => l.client_name_normalized))];
  const [{ data: related }, team] = await Promise.all([
    names.length
      ? supabase.from("leads").select("*").in("client_name_normalized", names).order("created_at")
      : Promise.resolve({ data: [] }),
    getTeam(),
  ]);
  const leads = await withAgentNames(related ?? []);

  const groups = new Map<string, LeadWithAgent[]>();
  for (const lead of leads) {
    const group = groups.get(lead.client_name_normalized) ?? [];
    group.push(lead);
    groups.set(lead.client_name_normalized, group);
  }

  return (
    <>
      <PageHeader
        title="Duplicates"
        description="Companies with more than one record. Keep one owner per company: reassign, delete the extra record, or mark the warning resolved if both are legitimate."
      />

      {groups.size === 0 ? (
        <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-card p-10 text-center">
          <CopyCheck className="size-8 text-success" />
          <p className="font-medium">No open duplicates.</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            When someone saves a company that already exists, it shows up here for review.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {groups.size === 1 ? "1 company needs review." : `${groups.size} companies need review.`}
          </p>
          {[...groups.entries()].map(([key, records]) => {
            const owners = new Set(records.map((r) => r.agent_name ?? "Unassigned"));
            return (
              <section key={key} className="rounded-xl border bg-card shadow-sm">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
                  <div>
                    <h2 className="font-semibold">{records[0].client_name}</h2>
                    <p className="text-xs text-muted-foreground">
                      {records.length} records · handled by {[...owners].join(", ")}
                    </p>
                  </div>
                  {owners.size > 1 ? (
                    <span className="text-xs font-medium text-urgent">Several agents on one company</span>
                  ) : null}
                </header>
                <ul className="divide-y">
                  {records.map((lead) => (
                    <li key={lead.id} className="grid gap-3 px-5 py-3 lg:grid-cols-[1fr_auto_14rem_auto] lg:items-center">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link href={`/leads/${lead.id}`} className="font-medium hover:text-primary hover:underline">
                            {lead.client_name}
                          </Link>
                          {lead.is_duplicate ? <DuplicateBadge label={lead.duplicate_label} /> : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {lead.policy_product} · {lead.type}
                          {lead.renewal_date ? ` · renews ${formatDate(lead.renewal_date)}` : ""}
                          {lead.poc_name ? ` · ${lead.poc_name}` : ""} · added {formatDateTime(lead.created_at)}
                        </p>
                      </div>
                      <StatusBadge status={lead.status} />
                      <AssignAgentSelect
                        leadId={lead.id}
                        agentId={lead.assigned_agent_id}
                        agents={team.filter((m) => m.is_active || m.id === lead.assigned_agent_id)}
                      />
                      <div className="flex items-center gap-1">
                        {lead.is_duplicate ? <ResolveDuplicateButton leadId={lead.id} /> : null}
                        <DeleteLeadButton leadId={lead.id} clientName={lead.client_name} />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
