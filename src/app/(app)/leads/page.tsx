import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";

import { PageHeader } from "@/components/app-shell/page-header";
import { LeadFiltersBar } from "@/components/leads/lead-filters-bar";
import { EmptyLeads, LeadCards, LeadsTable } from "@/components/leads/lead-views";
import { LeadsKanban } from "@/components/leads/leads-kanban";
import { Button } from "@/components/ui/button";
import { isAdmin, requireProfile } from "@/lib/auth";
import { parseLeadFilters } from "@/lib/lead-filters";
import { getTeam, LEAD_LIST_LIMIT, listLeads } from "@/lib/leads";

export const metadata: Metadata = { title: "Leads" };

export default async function LeadsPage({ searchParams }: PageProps<"/leads">) {
  const profile = await requireProfile();
  const admin = isAdmin(profile);
  const filters = parseLeadFilters(await searchParams);
  // The board shows every status as a column, so the status filter does not apply there.
  const effective = filters.view === "kanban" ? { ...filters, status: null } : filters;

  const [{ leads, truncated }, team] = await Promise.all([listLeads(effective), getTeam()]);
  const agents = team.filter((member) => member.is_active);
  const filtered = Boolean(
    effective.q || effective.status || effective.product || effective.type || effective.agent || effective.renewal || effective.duplicates,
  );

  return (
    <>
      <PageHeader
        title="Leads"
        description={
          admin
            ? "Every lead in the company. Change status inline, or open a lead for POCs, notes and assignment."
            : "Leads assigned to you. Change status inline, or open a lead for POCs and notes."
        }
        actions={
          <Button asChild>
            <Link href="/leads/new">
              <Plus />
              New lead
            </Link>
          </Button>
        }
      />
      <LeadFiltersBar filters={filters} agents={agents} showAgentFilter={admin} />

      <p className="mb-3 text-xs text-muted-foreground">
        {leads.length === 1 ? "1 lead" : `${leads.length} leads`}
        {truncated ? ` (showing the first ${LEAD_LIST_LIMIT}; narrow the filters to see the rest)` : ""}
      </p>

      {leads.length === 0 ? (
        <EmptyLeads filtered={filtered} />
      ) : filters.view === "kanban" ? (
        <LeadsKanban leads={leads} showAgent={admin} />
      ) : filters.view === "cards" ? (
        <LeadCards leads={leads} showAgent={admin} />
      ) : (
        <LeadsTable leads={leads} showAgent={admin} />
      )}
    </>
  );
}
