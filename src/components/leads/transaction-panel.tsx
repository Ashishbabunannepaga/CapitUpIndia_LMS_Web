"use client";

import { useRef, useState, useTransition } from "react";
import { FileText, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import { deleteLeadTransaction, saveLeadTransaction } from "@/app/(app)/leads/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate } from "@/lib/dates";
import { safeAction } from "@/lib/safe-action";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/upload-limits";
import { cn } from "@/lib/utils";

export type TransactionRow = {
  id: number;
  transaction_date: string;
  policy_start_date: string | null;
  policy_status: "Policy Received" | "Policy Yet to Receive";
  policy_doc_path: string | null;
  policy_doc_name: string;
};

const STATUSES = ["Policy Yet to Receive", "Policy Received"] as const;

function TransactionForm({
  leadId,
  row,
  defaults,
  today,
  onDone,
}: {
  leadId: number;
  row: TransactionRow | null;
  defaults: { transaction_date: string; policy_start_date: string };
  today: string;
  onDone: () => void;
}) {
  const [status, setStatus] = useState<TransactionRow["policy_status"]>(row?.policy_status ?? "Policy Yet to Receive");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const prefix = row ? `tx-${row.id}` : "tx-new";

  return (
    <form
      ref={formRef}
      className="space-y-3 rounded-lg border bg-muted/30 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const file = formData.get("policy_doc");
        if (file instanceof File && file.size > MAX_UPLOAD_BYTES) {
          setError(`The policy file is larger than ${MAX_UPLOAD_LABEL}.`);
          return;
        }
        if (row) formData.set("id", String(row.id));
        setError(null);
        startTransition(async () => {
          const result = await safeAction(() => saveLeadTransaction(leadId, formData));
          if (result.ok) onDone();
          else setError(result.error);
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-date`}>Transaction date</Label>
          <Input
            id={`${prefix}-date`}
            name="transaction_date"
            type="date"
            required
            max={today}
            defaultValue={row?.transaction_date ?? defaults.transaction_date}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-start`}>Policy start date</Label>
          <Input
            id={`${prefix}-start`}
            name="policy_start_date"
            type="date"
            defaultValue={row?.policy_start_date ?? defaults.policy_start_date}
          />
        </div>
      </div>
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">Policy status</legend>
        <div className="flex flex-wrap gap-2">
          {STATUSES.map((value) => (
            <label
              key={value}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors",
                status === value ? "border-primary bg-accent font-medium" : "hover:bg-accent/60",
              )}
            >
              <input
                type="radio"
                name="policy_status"
                value={value}
                checked={status === value}
                onChange={() => setStatus(value)}
                className="accent-primary"
              />
              {value}
            </label>
          ))}
        </div>
      </fieldset>
      {status === "Policy Received" ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-doc`}>
            {row?.policy_doc_path ? "Replace the policy copy" : "Upload the policy"}{" "}
            <span className="font-normal text-muted-foreground">(PDF or photo, up to {MAX_UPLOAD_LABEL})</span>
          </Label>
          <Input id={`${prefix}-doc`} name="policy_doc" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" />
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : null}
          {row ? "Save changes" : "Save transaction"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Transaction details of a Closed Won or Renewed lead: one entry per policy
 * cycle with its dates, whether the policy has been received, and the policy
 * copy once it has.
 */
export function TransactionPanel({
  leadId,
  rows,
  defaults,
  today,
  isAdmin,
}: {
  leadId: number;
  rows: TransactionRow[];
  defaults: { transaction_date: string; policy_start_date: string };
  today: string;
  isAdmin: boolean;
}) {
  const [editing, setEditing] = useState<number | "new" | null>(rows.length === 0 ? "new" : null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      {rows.length === 0 && editing !== "new" ? (
        <p className="text-sm text-muted-foreground">No transaction recorded yet.</p>
      ) : null}
      <ul className="space-y-3">
        {rows.map((row) =>
          editing === row.id ? (
            <li key={row.id}>
              <TransactionForm leadId={leadId} row={row} defaults={defaults} today={today} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={row.id} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <dl className="grid flex-1 gap-x-6 gap-y-2 sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">Transaction date</dt>
                    <dd>{formatDate(row.transaction_date)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Policy start date</dt>
                    <dd>{row.policy_start_date ? formatDate(row.policy_start_date) : "Not set"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Policy</dt>
                    <dd
                      className={cn(
                        "font-medium",
                        row.policy_status === "Policy Received" ? "text-success" : "text-amber-700 dark:text-amber-300",
                      )}
                    >
                      {row.policy_status}
                    </dd>
                  </div>
                </dl>
                <div className="flex items-center gap-1">
                  <Button type="button" variant="ghost" size="icon" aria-label="Edit transaction" onClick={() => setEditing(row.id)}>
                    <Pencil />
                  </Button>
                  {isAdmin ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Delete transaction"
                      disabled={pending}
                      onClick={() => {
                        if (!window.confirm("Delete this transaction? The policy file stays in storage.")) return;
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
              </div>
              {row.policy_doc_path ? (
                <a
                  href={`/leads/${leadId}/policy?t=${row.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                >
                  <FileText className="size-4" />
                  {row.policy_doc_name || "Policy copy"}
                </a>
              ) : row.policy_status === "Policy Received" ? (
                <p className="mt-2 text-xs text-muted-foreground">No policy copy uploaded yet. Use edit to add it.</p>
              ) : null}
            </li>
          ),
        )}
      </ul>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {editing === "new" ? (
        <TransactionForm leadId={leadId} row={null} defaults={defaults} today={today} onDone={() => setEditing(null)} />
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing("new")}>
          <Plus />
          Add transaction
        </Button>
      )}
    </div>
  );
}
