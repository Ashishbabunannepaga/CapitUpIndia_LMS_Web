"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, Merge, Sparkles, Trash2, Upload } from "lucide-react";

import {
  commitImport,
  previewPastedRows,
  previewUploadedSheet,
  type CommitResult,
  type PreviewResult,
  type PreviewRow,
} from "@/app/(app)/admin/import/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/dates";
import { LEAD_STATUSES, POLICY_PRODUCTS } from "@/lib/domain";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/upload-limits";
import { cn } from "@/lib/utils";

type Agent = { id: string; full_name: string };

type Editable = PreviewRow & { include: boolean };

const SAMPLE = `NAME OF THE CLIENT\tCONTACT DETAILS\tCONTACT PERSON\tDATE OF RENEWAL\tREMARKS
Renee Systems Pvt Ltd\t9845012345\tRajesh (Director)\t15 Nov\tGroup health, 120 lives
Kaveri Textiles\tpriya@kaveri.in\tPriya\t23 rd Feb Renewal\tFire policy, wants a quote`;

function RowIssues({ row }: { row: Editable }) {
  if (row.errors.length === 0 && row.warnings.length === 0) return null;
  return (
    <div className="space-y-0.5 text-xs">
      {row.errors.map((e) => (
        <p key={e} className="text-destructive">
          {e}
        </p>
      ))}
      {row.warnings.map((w) => (
        <p key={w} className="text-muted-foreground">
          {w}
        </p>
      ))}
    </div>
  );
}

export function ImportWorkspace({ agents, aiConfigured }: { agents: Agent[]; aiConfigured: boolean }) {
  const [text, setText] = useState("");
  const [useAi, setUseAi] = useState(aiConfigured);
  const [rows, setRows] = useState<Editable[] | null>(null);
  const [meta, setMeta] = useState<{ mappedBy: string; notice?: string; skipped: number } | null>(null);
  const [status, setStatus] = useState<string>("Prospect");
  const [allocation, setAllocation] = useState<"round_robin" | "agent" | "unassigned">("round_robin");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Extract<CommitResult, { ok: true }> | null>(null);
  const [pending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);

  function apply(result: PreviewResult) {
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setDone(null);
    setRows(result.rows.map((row) => ({ ...row, include: row.errors.length === 0 })));
    setMeta({ mappedBy: result.mappedBy, notice: result.notice, skipped: result.skipped });
  }

  function preview() {
    setError(null);
    startTransition(async () => {
      apply(await previewPastedRows(text, useAi));
    });
  }

  function upload(file: File) {
    setError(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`That file is larger than ${MAX_UPLOAD_LABEL}. Split it, or paste the rows instead.`);
      return;
    }
    const formData = new FormData();
    formData.set("sheet", file);
    formData.set("use_ai", String(useAi));
    startTransition(async () => {
      apply(await previewUploadedSheet(formData));
    });
  }

  function edit(row: number, field: keyof PreviewRow["lead"], value: string) {
    setRows((current) =>
      current?.map((r) =>
        r.row === row
          ? {
              ...r,
              lead: { ...r.lead, [field]: value } as PreviewRow["lead"],
              errors: field === "client_name" ? (value.trim() ? [] : ["No company or client name"]) : r.errors,
            }
          : r,
      ) ?? null,
    );
  }

  function commit() {
    const selected = rows?.filter((r) => r.include && r.errors.length === 0) ?? [];
    if (selected.length === 0) {
      setError("Tick at least one row to import.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await commitImport({
        status,
        allocation,
        agentId,
        rows: selected.map((r) => r.lead),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(result);
      setRows(null);
      setMeta(null);
      setText("");
    });
  }

  const includable = rows?.filter((r) => r.errors.length === 0) ?? [];
  const selected = includable.filter((r) => r.include);
  const mergeCount = selected.filter((r) => r.existing).length;

  return (
    <div className="space-y-6">
      {done ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-semibold">
              Imported {done.created} new {done.created === 1 ? "lead" : "leads"}
              {done.merged > 0 ? ` and merged ${done.merged} into existing companies` : ""}.
            </p>
            {done.failed > 0 ? (
              <p className="mt-1 text-emerald-900/80">
                {done.failed} {done.failed === 1 ? "row" : "rows"} could not be imported: {done.errors.join("; ")}
              </p>
            ) : null}
            <Link href="/leads?sort=created" className="mt-1 inline-block font-medium underline">
              Open the leads list
            </Link>
          </div>
        </div>
      ) : null}

      {!rows ? (
        <section className="space-y-4 rounded-xl border bg-card p-5 shadow-sm">
          <div>
            <h2 className="font-semibold">Paste or upload the sheet</h2>
            <p className="text-sm text-muted-foreground">
              Any column order works. Rows are mapped, checked for duplicates, and shown to you before anything is
              created.
            </p>
          </div>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            className="font-mono text-xs"
            placeholder={SAMPLE}
            aria-label="Pasted rows"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className={cn("flex items-center gap-2 text-sm", !aiConfigured && "text-muted-foreground")}>
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={useAi}
                disabled={!aiConfigured}
                onChange={(e) => setUseAi(e.target.checked)}
              />
              <Sparkles className="size-4" />
              Use AI column mapping
              {!aiConfigured ? <span className="text-xs">(AI is not configured on this server)</span> : null}
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileInput}
                type="file"
                accept=".xlsx,.csv,.tsv,.txt"
                className="sr-only"
                tabIndex={-1}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) upload(file);
                  e.target.value = "";
                }}
              />
              <Button type="button" variant="outline" onClick={() => fileInput.current?.click()} disabled={pending}>
                <Upload />
                Upload .xlsx or .csv
              </Button>
              <Button type="button" onClick={preview} disabled={pending || !text.trim()}>
                {pending ? <Loader2 className="animate-spin" /> : <FileSpreadsheet />}
                {pending ? "Mapping rows…" : "Preview rows"}
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {rows ? (
        <section className="space-y-4 rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">
                Review {rows.length} {rows.length === 1 ? "row" : "rows"}
              </h2>
              <p className="text-sm text-muted-foreground">
                Mapped by {meta?.mappedBy === "ai" ? "AI" : "column matching"}. Edit anything before importing.
                {mergeCount > 0
                  ? ` ${mergeCount} ${mergeCount === 1 ? "row goes" : "rows go"} into companies already in the CRM: their contacts are added, nothing is overwritten.`
                  : ""}
              </p>
              {meta?.notice ? <p className="mt-1 text-sm text-amber-700">{meta.notice}</p> : null}
              {meta?.skipped ? (
                <p className="mt-1 text-sm text-amber-700">
                  Only the first {rows.length} rows are shown; import the remaining {meta.skipped} in a second batch.
                </p>
              ) : null}
            </div>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setRows(null);
                setMeta(null);
              }}
            >
              <Trash2 />
              Start over
            </Button>
          </div>

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[1280px] text-sm">
              <thead className="bg-muted/50 text-left text-xs tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select all rows"
                      className="size-4 accent-primary"
                      checked={includable.length > 0 && selected.length === includable.length}
                      onChange={(e) =>
                        setRows(
                          (current) =>
                            current?.map((r) => (r.errors.length === 0 ? { ...r, include: e.target.checked } : r)) ??
                            null,
                        )
                      }
                    />
                  </th>
                  <th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2">Renewal</th>
                  <th className="px-3 py-2">Primary POC</th>
                  <th className="px-3 py-2">Phone</th>
                  <th className="px-3 py-2">Email</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.row} className={cn("align-top", row.errors.length > 0 && "bg-red-50/60")}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Import row ${row.row}`}
                        className="size-4 accent-primary"
                        checked={row.include}
                        disabled={row.errors.length > 0}
                        onChange={(e) =>
                          setRows(
                            (current) =>
                              current?.map((r) => (r.row === row.row ? { ...r, include: e.target.checked } : r)) ?? null,
                          )
                        }
                      />
                    </td>
                    <td className="min-w-56 px-3 py-2">
                      <Input
                        value={row.lead.client_name}
                        onChange={(e) => edit(row.row, "client_name", e.target.value)}
                        aria-label={`Company for row ${row.row}`}
                        className="h-8"
                      />
                      <p className="mt-1 truncate text-[11px] text-muted-foreground" title={row.source}>
                        Row {row.row}: {row.source}
                      </p>
                      <RowIssues row={row} />
                      {row.existing ? (
                        <p className="mt-1 flex items-center gap-1 text-xs font-medium text-amber-700">
                          <Merge className="size-3" />
                          Merging into lead #{row.existing.id}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <NativeSelect
                        size="sm"
                        className="w-40"
                        value={row.lead.policy_product}
                        aria-label={`Product for row ${row.row}`}
                        onChange={(e) => edit(row.row, "policy_product", e.target.value)}
                      >
                        {POLICY_PRODUCTS.map((p) => (
                          <option key={p}>{p}</option>
                        ))}
                      </NativeSelect>
                      {row.lead.sub_product_name ? (
                        <p className="mt-1 text-[11px] text-muted-foreground">{row.lead.sub_product_name}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        type="date"
                        value={row.lead.renewal_date}
                        aria-label={`Renewal date for row ${row.row}`}
                        onChange={(e) => edit(row.row, "renewal_date", e.target.value)}
                        className="h-8 w-36"
                      />
                      {row.lead.renewal_date ? (
                        <p className="mt-1 text-[11px] text-muted-foreground">{formatDate(row.lead.renewal_date)}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        value={row.lead.poc_name}
                        aria-label={`Contact for row ${row.row}`}
                        onChange={(e) => edit(row.row, "poc_name", e.target.value)}
                        className="h-8 w-36"
                      />
                      {row.lead.poc_designation ? (
                        <p className="mt-1 text-[11px] text-muted-foreground">{row.lead.poc_designation}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        value={row.lead.poc_contact_number}
                        aria-label={`Phone for row ${row.row}`}
                        onChange={(e) => edit(row.row, "poc_contact_number", e.target.value)}
                        className="h-8 w-32"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        value={row.lead.poc_email_id}
                        aria-label={`Email for row ${row.row}`}
                        onChange={(e) => edit(row.row, "poc_email_id", e.target.value)}
                        className="h-8 w-44"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-4 rounded-lg border bg-muted/30 p-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="import-status">Status for imported leads</Label>
              <NativeSelect id="import-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                {LEAD_STATUSES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="import-allocation">Assign new leads</Label>
              <NativeSelect
                id="import-allocation"
                value={allocation}
                onChange={(e) => setAllocation(e.target.value as typeof allocation)}
              >
                <option value="round_robin">Round-robin across active agents</option>
                <option value="agent">One agent</option>
                <option value="unassigned">Leave unassigned</option>
              </NativeSelect>
            </div>
            {allocation === "agent" ? (
              <div className="space-y-1.5">
                <Label htmlFor="import-agent">Agent</Label>
                <NativeSelect id="import-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.full_name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {selected.length} of {rows.length} rows selected
              {rows.length - includable.length > 0 ? `, ${rows.length - includable.length} cannot be imported` : ""}.
            </p>
            <Button type="button" onClick={commit} disabled={pending || selected.length === 0}>
              {pending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
              Import {selected.length} {selected.length === 1 ? "row" : "rows"}
            </Button>
          </div>
          {allocation === "round_robin" && agents.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-amber-700">
              <AlertTriangle className="size-4" />
              There are no active agents, so new leads will be left unassigned.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
