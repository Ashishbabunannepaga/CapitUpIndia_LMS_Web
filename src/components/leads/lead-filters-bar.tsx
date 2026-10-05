"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Columns3, LayoutGrid, Loader2, Search, Table2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { LEAD_STATUSES, LEAD_TYPES, POLICY_PRODUCTS } from "@/lib/domain";
import {
  LEAD_SORTS,
  leadsHref,
  RENEWAL_WINDOWS,
  type LeadFilters,
  type LeadView,
} from "@/lib/lead-filters";
import { cn } from "@/lib/utils";

const VIEWS: { view: LeadView; label: string; icon: typeof Table2 }[] = [
  { view: "table", label: "Table", icon: Table2 },
  { view: "cards", label: "Cards", icon: LayoutGrid },
  { view: "kanban", label: "Kanban", icon: Columns3 },
];

export function LeadFiltersBar({
  filters,
  agents,
  showAgentFilter,
}: {
  filters: LeadFilters;
  agents: { id: string; full_name: string }[];
  showAgentFilter: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(filters.q);
  const skipSearch = useRef(false);

  const apply = (patch: Partial<LeadFilters>) => {
    startTransition(() => {
      router.replace(leadsHref({ ...filters, ...patch }), { scroll: false });
    });
  };

  // Debounced search.
  useEffect(() => {
    if (skipSearch.current) {
      skipSearch.current = false;
      return;
    }
    if (q === filters.q) return;
    const timer = setTimeout(() => apply({ q }), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const active =
    filters.q || filters.status || filters.product || filters.type || filters.agent || filters.renewal || filters.duplicates;

  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search company, POC, phone, email, product or notes"
            aria-label="Search leads"
            className="bg-card pl-9"
          />
          {pending ? (
            <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        <div className="flex items-center gap-1 rounded-lg border bg-card p-1" role="tablist" aria-label="View">
          {VIEWS.map(({ view, label, icon: Icon }) => (
            <Link
              key={view}
              role="tab"
              aria-selected={filters.view === view}
              href={leadsHref({ ...filters, view })}
              scroll={false}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                filters.view === view && "bg-accent text-accent-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:flex lg:flex-wrap lg:items-center">
        {filters.view !== "kanban" ? (
          <NativeSelect
            size="sm"
            aria-label="Status"
            className="lg:w-40"
            value={filters.status ?? ""}
            onChange={(e) => apply({ status: (e.target.value || null) as LeadFilters["status"] })}
          >
            <option value="">All statuses</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </NativeSelect>
        ) : null}
        <NativeSelect
          size="sm"
          aria-label="Product"
          className="lg:w-40"
          value={filters.product ?? ""}
          onChange={(e) => apply({ product: (e.target.value || null) as LeadFilters["product"] })}
        >
          <option value="">All products</option>
          {POLICY_PRODUCTS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          size="sm"
          aria-label="New or renewal"
          className="lg:w-36"
          value={filters.type ?? ""}
          onChange={(e) => apply({ type: (e.target.value || null) as LeadFilters["type"] })}
        >
          <option value="">New and renewal</option>
          {LEAD_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          size="sm"
          aria-label="Renewal date"
          className="lg:w-44"
          value={filters.renewal ?? ""}
          onChange={(e) => apply({ renewal: (e.target.value || null) as LeadFilters["renewal"] })}
        >
          <option value="">Any renewal date</option>
          {Object.entries(RENEWAL_WINDOWS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
        {showAgentFilter ? (
          <NativeSelect
            size="sm"
            aria-label="Assigned agent"
            className="lg:w-44"
            value={filters.agent ?? ""}
            onChange={(e) => apply({ agent: e.target.value || null })}
          >
            <option value="">All agents</option>
            <option value="unassigned">Unassigned</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.full_name}
              </option>
            ))}
          </NativeSelect>
        ) : null}
        <NativeSelect
          size="sm"
          aria-label="Sort"
          className="lg:w-48"
          value={filters.sort}
          onChange={(e) => apply({ sort: e.target.value as LeadFilters["sort"] })}
        >
          {Object.entries(LEAD_SORTS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
        <Button
          type="button"
          size="sm"
          variant={filters.duplicates ? "default" : "outline"}
          aria-pressed={filters.duplicates}
          onClick={() => apply({ duplicates: !filters.duplicates })}
          className={cn(!filters.duplicates && "bg-card")}
        >
          <AlertTriangle />
          Duplicates only
        </Button>
        {active ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              skipSearch.current = q !== "";
              setQ("");
              startTransition(() => router.replace(leadsHref({ view: filters.view, sort: filters.sort }), { scroll: false }));
            }}
          >
            <X />
            Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  );
}
