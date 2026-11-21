"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, FileUp, Loader2, ShieldCheck, X } from "lucide-react";
import { Dialog } from "radix-ui";

import { setLeadStatus } from "@/app/(app)/leads/actions";
import {
  confirmPolicy,
  discardPolicyUpload,
  recheckPolicy,
  resumePolicyReview,
  uploadPolicy,
  type PolicyReviewResult,
} from "@/app/(app)/leads/policy-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CheckResult, PolicyCheck } from "@/lib/policy-check";
import { safeAction } from "@/lib/safe-action";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/upload-limits";
import { cn } from "@/lib/utils";

type Review = Extract<PolicyReviewResult, { ok: true }>;

const RESULT_STYLES: Record<CheckResult, { icon: typeof CheckCircle2; text: string; label: string }> = {
  match: { icon: CheckCircle2, text: "text-success", label: "Match" },
  differs: { icon: AlertTriangle, text: "text-urgent", label: "Differs" },
  missing: { icon: CircleHelp, text: "text-muted-foreground", label: "Not on policy" },
};

function ValueFields({ values, prefix, oneTime }: { values: Review["values"] | null; prefix: string; oneTime: boolean }) {
  const v = values;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-start`}>Policy start date</Label>
        <Input id={`${prefix}-start`} name="policy_start_date" type="date" defaultValue={v?.policy_start_date ?? ""} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-end`}>
          Policy end date{" "}
          <span className="font-normal text-muted-foreground">{oneTime ? "(no renewal)" : "(next renewal)"}</span>
        </Label>
        <Input id={`${prefix}-end`} name="policy_end_date" type="date" defaultValue={v?.policy_end_date ?? ""} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-premium`}>Premium (₹, incl. GST)</Label>
        <Input id={`${prefix}-premium`} name="premium" inputMode="decimal" defaultValue={v?.premium ?? ""} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-number`}>Policy number</Label>
        <Input id={`${prefix}-number`} name="policy_number" defaultValue={v?.policy_number ?? ""} />
      </div>
      {v ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={`${prefix}-insurer`}>Insurer</Label>
            <Input id={`${prefix}-insurer`} name="insurer" defaultValue={v.insurer} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${prefix}-sum`}>Sum insured (₹)</Label>
            <Input id={`${prefix}-sum`} name="sum_insured" inputMode="decimal" defaultValue={v.sum_insured ?? ""} />
          </div>
        </>
      ) : null}
    </div>
  );
}

export function PolicyChecks({ checks }: { checks: PolicyCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Check</th>
            <th className="px-3 py-2 font-medium">Lead / you</th>
            <th className="px-3 py-2 font-medium">Policy says</th>
            <th className="px-3 py-2 font-medium">Result</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => {
            const style = RESULT_STYLES[c.result];
            const Icon = style.icon;
            return (
              <tr key={c.field} className="border-t align-top">
                <td className="px-3 py-2 font-medium">{c.label}</td>
                <td className="px-3 py-2">{c.expected || <span className="text-muted-foreground">—</span>}</td>
                <td className="px-3 py-2">
                  {c.found || <span className="text-muted-foreground">—</span>}
                  {c.note ? <p className="text-xs text-muted-foreground">{c.note}</p> : null}
                </td>
                <td className={cn("px-3 py-2 whitespace-nowrap", style.text)}>
                  <span className="inline-flex items-center gap-1">
                    <Icon className="size-4" />
                    {style.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Closing a lead with its policy: upload the PDF or photo (with what the
 * agent knows), review what was read against the lead, then confirm to make
 * it Closed Won. Closing without the file leaves it Closed Awaiting Policy.
 */
export function PolicyCloseDialog({
  open,
  leadId,
  clientName,
  isAdmin = false,
  renewing = false,
  resumeCycleId,
  onClose,
}: {
  open: boolean;
  leadId: number;
  clientName: string;
  /** Admins may also mark Closed Won without a policy. */
  isAdmin?: boolean;
  /** A client uploading next year's policy (the status stays until confirmed). */
  renewing?: boolean;
  /** Open an earlier unconfirmed upload straight in review. */
  resumeCycleId?: number | null;
  onClose: () => void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [resumed, setResumed] = useState(false);

  if (open && resumeCycleId && !resumed && !review) {
    setResumed(true);
    startTransition(async () => {
      const result = await safeAction(() => resumePolicyReview(resumeCycleId));
      if (result.ok) setReview(result as Review);
      else setError(result.error);
    });
  }

  const close = () => {
    setReview(null);
    setError(null);
    setDone(null);
    setResumed(false);
    onClose();
  };

  const differs = review?.checks.some((c) => c.result === "differs") ?? false;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? null : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-in bg-black/40 fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-card p-5 shadow-lift">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="space-y-1">
              <Dialog.Title className="font-semibold">
                {done ? "Closed Won" : review ? "Check the policy" : renewing ? "Upload this year's policy" : "Close with the policy"}
              </Dialog.Title>
              <Dialog.Description className="text-sm text-muted-foreground">
                {done
                  ? `${clientName} is Closed Won as ${done}.`
                  : review
                    ? "Compare what the policy says with the lead. Correct anything wrong, then confirm."
                    : `Upload ${clientName}'s policy. It is read automatically and checked against the lead before the lead becomes Closed Won.`}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Close">
                <X />
              </Button>
            </Dialog.Close>
          </div>

          {done ? (
            <div className="space-y-4">
              <p className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                <ShieldCheck className="size-4" />
                Client code {done}. The renewal date is now the policy end date, and the policy is in Policy history.
              </p>
              <div className="flex justify-end">
                <Button type="button" size="sm" onClick={close}>
                  Done
                </Button>
              </div>
            </div>
          ) : review ? (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                const formData = new FormData(event.currentTarget);
                setError(null);
                startTransition(async () => {
                  const result = await safeAction(() => confirmPolicy(review.cycleId, formData));
                  if (result.ok) setDone(result.clientCode);
                  else setError(result.error);
                });
              }}
            >
              {review.notice ? (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{review.notice}</p>
              ) : null}
              <PolicyChecks checks={review.checks} />
              <ValueFields values={review.values} prefix={`policy-${review.cycleId}`} oneTime={review.oneTime} />
              {differs ? (
                <label className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                  <input type="checkbox" name="acknowledged" className="mt-0.5 accent-primary" />
                  I&apos;ve checked these differences and the values above are right. (Admins will see this policy was confirmed with
                  differences.)
                </label>
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <div className="flex flex-wrap justify-between gap-2">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={(event) => {
                      const form = event.currentTarget.form;
                      if (!form) return;
                      const formData = new FormData(form);
                      setError(null);
                      startTransition(async () => {
                        const result = await safeAction(() => recheckPolicy(review.cycleId, formData));
                        if (result.ok) setReview({ ...(result as Review), notice: review.notice });
                        else setError(result.error);
                      });
                    }}
                  >
                    Re-check
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => {
                      if (!window.confirm("Discard this upload? The lead stays Closed Awaiting Policy.")) return;
                      startTransition(async () => {
                        const result = await safeAction(() => discardPolicyUpload(review.cycleId));
                        if (result.ok) close();
                        else setError(result.error);
                      });
                    }}
                  >
                    Discard upload
                  </Button>
                </div>
                <Button type="submit" size="sm" disabled={pending}>
                  {pending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                  Confirm and mark Closed Won
                </Button>
              </div>
            </form>
          ) : pending && resumeCycleId ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading the upload…
            </p>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                const formData = new FormData(event.currentTarget);
                const file = formData.get("policy_doc");
                if (!(file instanceof File) || file.size === 0) {
                  setError("Choose the policy file (PDF or photo).");
                  return;
                }
                if (file.size > MAX_UPLOAD_BYTES) {
                  setError(`The policy file is larger than ${MAX_UPLOAD_LABEL}.`);
                  return;
                }
                setError(null);
                startTransition(async () => {
                  const result = await safeAction(() => uploadPolicy(leadId, formData));
                  if (result.ok) setReview(result as Review);
                  else setError(result.error);
                });
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor={`policy-file-${leadId}`}>
                  Policy document <span className="font-normal text-muted-foreground">(PDF or photo, up to {MAX_UPLOAD_LABEL})</span>
                </Label>
                <Input
                  id={`policy-file-${leadId}`}
                  name="policy_doc"
                  type="file"
                  accept="application/pdf,image/jpeg,image/png,image/webp"
                  capture="environment"
                />
              </div>
              <div>
                <p className="mb-2 text-xs text-muted-foreground">
                  What you know about the policy (optional): it is compared with what the document says.
                </p>
                <ValueFields values={null} prefix={`policy-new-${leadId}`} oneTime={false} />
              </div>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-2">
                  {!renewing ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        startTransition(async () => {
                          const result = await safeAction(() => setLeadStatus(leadId, "Closed Awaiting Policy"));
                          if (result.ok) close();
                          else setError(result.error);
                        });
                      }}
                    >
                      No policy yet: mark Closed Awaiting Policy
                    </Button>
                  ) : null}
                  {isAdmin && !renewing ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        if (!window.confirm("Mark Closed Won without checking a policy? This is logged.")) return;
                        startTransition(async () => {
                          const result = await safeAction(() => setLeadStatus(leadId, "Closed Won"));
                          if (result.ok) close();
                          else setError(result.error);
                        });
                      }}
                    >
                      Admin: Closed Won without policy
                    </Button>
                  ) : null}
                </div>
                <Button type="submit" size="sm" disabled={pending}>
                  {pending ? <Loader2 className="animate-spin" /> : <FileUp />}
                  {pending ? "Reading the policy…" : "Upload and check"}
                </Button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A button that opens the policy dialog (lead page). */
export function PolicyCloseButton({
  leadId,
  clientName,
  isAdmin,
  renewing,
  resumeCycleId,
  label,
  variant = "outline",
  autoOpen = false,
}: {
  leadId: number;
  clientName: string;
  isAdmin: boolean;
  renewing?: boolean;
  resumeCycleId?: number | null;
  label: string;
  variant?: "outline" | "default";
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen);
  return (
    <>
      <Button type="button" variant={variant} size="sm" onClick={() => setOpen(true)}>
        <FileUp />
        {label}
      </Button>
      <PolicyCloseDialog
        open={open}
        leadId={leadId}
        clientName={clientName}
        isAdmin={isAdmin}
        renewing={renewing}
        resumeCycleId={resumeCycleId}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
