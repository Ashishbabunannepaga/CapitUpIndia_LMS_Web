import type { Metadata } from "next";
import { Download, Trash2 } from "lucide-react";

import { RestoreLeadButton } from "@/components/admin/restore-lead-button";
import { PageHeader } from "@/components/app-shell/page-header";
import { requireSession } from "@/lib/auth";
import { formatNoteTimestamp } from "@/lib/dates";
import { BIN_DAYS, listDeletedLeads, listExports } from "@/server/data/data-safety";

export const metadata: Metadata = { title: "Deleted & exports" };

const FILTER_LABELS: Record<string, string> = {
  q: "Search",
  status: "Status",
  product: "Product",
  type: "Type",
  agent: "Agent",
  renewal: "Renewal",
  outcome: "Outcome",
  tag: "Tag",
  month: "Month",
};

function describeFilters(filters: Record<string, string>): string {
  const parts = Object.entries(filters)
    .filter(([key]) => key !== "view" && key !== "page" && key !== "sort")
    .map(([key, value]) => `${FILTER_LABELS[key] ?? key}: ${value}`);
  return parts.length ? parts.join(" · ") : "All leads";
}

// Deleted leads (restorable for BIN_DAYS) and every Excel export of client
// data. The admin layout requires an admin; the data functions check again.
export default async function DeletedAndExportsPage() {
  const { ctx, actor } = await requireSession();
  const [deleted, exports] = await Promise.all([listDeletedLeads(ctx, actor), listExports(ctx, actor)]);

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Deleted & exports"
        description={`Deleted leads stay here for ${BIN_DAYS} days and can be restored with their notes, reminders and policies. Below, every Excel download of client data: who, what and how many rows.`}
      />

      <section className="mb-8 overflow-hidden rounded-2xl border bg-card shadow-card">
        <header className="flex items-center gap-2 border-b px-5 py-3">
          <Trash2 className="size-4 text-muted-foreground" />
          <h2 className="font-semibold">Deleted leads</h2>
          <span className="text-xs text-muted-foreground">({deleted.length})</span>
        </header>
        {deleted.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">Nothing in the bin.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Lead</th>
                  <th className="px-4 py-3">Owner</th>
                  <th className="px-4 py-3">Deleted</th>
                  <th className="px-4 py-3">Kept</th>
                  <th className="px-4 py-3 text-right">
                    <span className="sr-only">Restore</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {deleted.map((row) => (
                  <tr key={row.lead_id}>
                    <td className="px-4 py-3">
                      <p className="font-medium">{row.client_name}</p>
                      <p className="text-xs text-muted-foreground">Lead #{row.lead_id}</p>
                    </td>
                    <td className="px-4 py-3">{row.owner_name ?? "Unassigned"}</td>
                    <td className="px-4 py-3">
                      <p>{formatNoteTimestamp(row.deleted_at)}</p>
                      <p className="text-xs text-muted-foreground">by {row.deleted_by_name ?? "a former user"}</p>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {row.notes} note{row.notes === 1 ? "" : "s"}, {row.events} calendar entr{row.events === 1 ? "y" : "ies"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <RestoreLeadButton leadId={row.lead_id} clientName={row.client_name} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-2xl border bg-card shadow-card">
        <header className="flex items-center gap-2 border-b px-5 py-3">
          <Download className="size-4 text-muted-foreground" />
          <h2 className="font-semibold">Exports</h2>
          <span className="text-xs text-muted-foreground">(latest {exports.length})</span>
        </header>
        {exports.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">No exports yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Who</th>
                  <th className="px-4 py-3">Report</th>
                  <th className="px-4 py-3 text-right">Rows</th>
                  <th className="px-4 py-3">Filters</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {exports.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-3 whitespace-nowrap">{formatNoteTimestamp(row.at)}</td>
                    <td className="px-4 py-3">{row.actor_name}</td>
                    <td className="px-4 py-3">{row.report}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.rows.toLocaleString("en-IN")}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{describeFilters(row.filters)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
