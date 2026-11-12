import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";

import { PageHeader } from "@/components/app-shell/page-header";
import { LeadFiltersBar } from "@/components/leads/lead-filters-bar";
import { LeadSelectionProvider } from "@/components/leads/bulk-actions";
import { EmptyLeads, LeadCards, LeadsTable } from "@/components/leads/lead-views";
import { LeadsKanban } from "@/components/leads/leads-kanban";
import { Button } from "@/components/ui/button";
import { isAdmin, requireProfile } from "@/lib/auth";
import { formatCount } from "@/lib/analytics";
import { leadsHref, parseLeadFilters } from "@/lib/lead-filters";
import { countLeadsByStatus, getTeam, KANBAN_COLUMN_LIMIT, LEAD_PAGE_SIZE, listLeads } from "@/lib/leads";

export const metadata: Metadata = { title: "Leads" };

export default async function LeadsPage({ searchParams }: PageProps<"/leads">) {
  const profile = await requireProfile();
  const admin = isAdmin(profile);
  const filters = parseLeadFilters(await searchParams);
  // The board shows every status as a column, so the status filter does not apply there.
  const effective = filters.view === "kanban" ? { ...filters, status: null } : filters;

  // Status counts come from one GROUP BY: the total for the pager, and board
  // column totals when a column holds more cards than it shows.
  const [{ leads, truncated }, team, statusCounts] = await Promise.all([
    listLeads(effective),
    getTeam(),
    countLeadsByStatus(effective),
  ]);
  const kanban = filters.view === "kanban";
  const columnTotals = kanban && truncated ? statusCounts : null;
  const matching = Object.values(statusCounts).reduce((sum, n) => sum + n, 0);
  const firstShown = (filters.page - 1) * LEAD_PAGE_SIZE + 1;
  const lastShown = firstShown + leads.length - 1;
  const agents = team.filter((member) => member.is_active);
  const filtered = Boolean(
    effective.q ||
      effective.status ||
      effective.product ||
      effective.type ||
      effective.agent ||
      effective.renewal ||
      effective.duplicates ||
      effective.stale ||
      effective.tag,
  );

  return (
    <>
      <PageHeader
        eyebrow="Pipeline"
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
              Add lead
            </Link>
          </Button>
        }
      />
      <LeadFiltersBar filters={filters} agents={agents} showAgentFilter={admin} />

      <p className="mb-3 text-xs text-muted-foreground">
        {matching === 1 ? "1 lead" : `${formatCount(matching)} leads`}
        {kanban && truncated ? ` (each column shows its first ${KANBAN_COLUMN_LIMIT}; narrow the filters or use the table to see the rest)` : ""}
        {!kanban && leads.length > 0 && (filters.page > 1 || truncated) ? `, showing ${firstShown}-${lastShown}` : ""}
      </p>

      {leads.length === 0 ? (
        <EmptyLeads filtered={filtered} />
      ) : filters.view === "kanban" ? (
        <LeadsKanban leads={leads} totals={columnTotals} showAgent={admin} />
      ) : filters.view === "cards" ? (
        <LeadCards leads={leads} showAgent={admin} />
      ) : admin ? (
        <LeadSelectionProvider ids={leads.map((lead) => lead.id)} agents={agents.map(({ id, full_name }) => ({ id, full_name }))}>
          <LeadsTable leads={leads} showAgent selectable />
        </LeadSelectionProvider>
      ) : (
        <LeadsTable leads={leads} showAgent={false} />
      )}

      {!kanban && (filters.page > 1 || truncated) ? (
        <nav aria-label="Pages" className="mt-4 flex items-center justify-between gap-2">
          {filters.page > 1 ? (
            <Button asChild variant="outline" size="sm">
              <Link href={leadsHref({ ...filters, page: filters.page - 1 })} rel="prev">
                <ChevronLeft />
                Previous
              </Link>
            </Button>
          ) : (
            <span />
          )}
          <span className="text-xs text-muted-foreground tabular-nums">
            Page {filters.page} of {Math.max(1, Math.ceil(matching / LEAD_PAGE_SIZE))}
          </span>
          {truncated ? (
            <Button asChild variant="outline" size="sm">
              <Link href={leadsHref({ ...filters, page: filters.page + 1 })} rel="next">
                Next
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
