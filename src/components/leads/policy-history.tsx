"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, FileText, Hand, Loader2, RefreshCw, Repeat, Trash2, Trophy } from "lucide-react";

import { deleteLeadTransaction } from "@/app/(app)/leads/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate, formatDateTime } from "@/lib/dates";
import type { PolicyCheck } from "@/lib/policy-check";
import { safeAction } from "@/lib/safe-action";
import { cn } from "@/lib/utils";

import { PolicyChecks } from "./policy-close";

export type PolicyHistoryRow = {
  id: number;
  kind: "won" | "renewal" | "auto_renewed";
  verification: "pending" | "verified" | "differences" | "manual" | "not_checked";
  client_code: string | null;
  transaction_date: string;
  policy_start_date: string | null;
  policy_end_date: string | null;
  premium: number | null;
  sum_insured: number | null;
  insurer: string;
  policy_number: string;
  product: string | null;
  policy_status: "Policy Received" | "Policy Yet to Receive";
  policy_doc_path: string | null;
  policy_doc_name: string;
  previous_renewal_date: string | null;
  next_renewal_date: string | null;
  confirmed_at: string | null;
  checks: unknown;
};

const KIND = {
  won: { label: "Won", icon: Trophy },
  renewal: { label: "Renewed", icon: RefreshCw },
  auto_renewed: { label: "Auto-renewed", icon: Repeat },
} as const;

const VERIFICATION: Record<PolicyHistoryRow["verification"], { label: string; className: string; icon: typeof CheckCircle2 } | null> = {
  verified: { label: "Policy checked", className: "border-green-300 bg-green-50 text-green-800", icon: CheckCircle2 },
  differences: { label: "Confirmed with differences", className: "border-red-200 bg-red-50 text-red-700", icon: AlertTriangle },
  manual: { label: "Checked by hand", className: "border-amber-300 bg-amber-50 text-amber-800", icon: Hand },
  pending: { label: "Waiting to be confirmed", className: "border-violet-200 bg-violet-50 text-violet-800", icon: Loader2 },
  not_checked: null,
};

const inr = (n: number | null) => (n === null ? null : `₹${n.toLocaleString("en-IN")}`);

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * Every policy year of a lead, newest first: its client code, dates,
 * premium, insurer, policy copy and how it was checked. Last year's details
 * stay here after the renewal date moves on.
 */
export function PolicyHistory({ leadId, rows, isAdmin }: { leadId: number; rows: PolicyHistoryRow[]; isAdmin: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No policy years yet. When the lead is closed with its policy, each year (with its client code, dates, premium and the policy
        copy) is kept here.
      </p>
    );
  }
  return (
    <ol className="relative space-y-4 border-l pl-5">
      {rows.map((row) => {
        const kind = KIND[row.kind];
        const Icon = kind.icon;
        const check = VERIFICATION[row.verification];
        const checks = Array.isArray(row.checks) ? (row.checks as PolicyCheck[]) : [];
        return (
          <li key={row.id} className="relative">
            <span className="absolute top-1 -left-[1.95rem] flex size-6 items-center justify-center rounded-full border bg-card">
              <Icon className="size-3.5 text-primary" />
            </span>
            <div className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">
                    {kind.label}
                    {row.policy_start_date ? ` · ${row.policy_start_date.slice(0, 4)}` : ""}
                  </span>
                  {row.client_code ? <span className="font-mono text-xs text-success">{row.client_code}</span> : null}
                  {check ? (
                    <Badge variant="outline" className={check.className}>
                      <check.icon />
                      {check.label}
                    </Badge>
                  ) : null}
                </div>
                {isAdmin ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Delete this policy year"
                    disabled={pending}
                    onClick={() => {
                      if (!window.confirm("Delete this policy year from the history? The policy file stays in storage.")) return;
                      setError(null);
                      startTransition(async () => {
                        const result = await safeAction(() => deleteLeadTransaction(row.id));
                        if (!result.ok) setError(result.error);
                      });
                    }}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
              <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-3">
                <Fact
                  label="Policy period"
                  value={
                    row.policy_start_date || row.policy_end_date
                      ? `${row.policy_start_date ? formatDate(row.policy_start_date) : "?"} to ${row.policy_end_date ? formatDate(row.policy_end_date) : "?"}`
                      : null
                  }
                />
                <Fact label="Premium" value={inr(row.premium)} />
                <Fact label="Sum insured" value={inr(row.sum_insured)} />
                <Fact label="Insurer" value={row.insurer} />
                <Fact label="Policy number" value={row.policy_number} />
                <Fact label="Product" value={row.product} />
                <Fact
                  label="Renewal date moved"
                  value={
                    row.previous_renewal_date || row.next_renewal_date
                      ? `${row.previous_renewal_date ? formatDate(row.previous_renewal_date) : "none"} → ${row.next_renewal_date ? formatDate(row.next_renewal_date) : "no renewal"}`
                      : null
                  }
                />
                <Fact label="Recorded" value={row.confirmed_at ? formatDateTime(row.confirmed_at) : formatDate(row.transaction_date)} />
              </dl>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                {row.policy_doc_path ? (
                  <a
                    href={`/leads/${leadId}/policy?t=${row.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
                  >
                    <FileText className="size-4" />
                    {row.policy_doc_name || "Policy copy"}
                  </a>
                ) : (
                  <span className="text-xs text-muted-foreground">No policy copy on file.</span>
                )}
                {checks.length > 0 ? (
                  <button
                    type="button"
                    className={cn("text-xs text-muted-foreground underline-offset-2 hover:underline")}
                    onClick={() => setOpen(open === row.id ? null : row.id)}
                  >
                    {open === row.id ? "Hide checks" : "Show checks"}
                  </button>
                ) : null}
              </div>
              {open === row.id ? (
                <div className="mt-3">
                  <PolicyChecks checks={checks} />
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </ol>
  );
}
