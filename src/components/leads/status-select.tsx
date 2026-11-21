"use client";

import { useOptimistic, useState, useTransition } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { Select } from "radix-ui";

import { setLeadStatus } from "@/app/(app)/leads/actions";
import type { LeadStatus, LostReason } from "@/lib/database.types";
import { todayInBusinessTz } from "@/lib/dates";
import { LEAD_STATUSES, LOST_STATUS, POLICY_GATED_STATUS, STATUS_STYLES, statusesFor } from "@/lib/domain";
import { rolloverForStatusChange } from "@/lib/renewal-rollover";
import { safeAction } from "@/lib/safe-action";
import { cn } from "@/lib/utils";

import { LostReasonDialog, VerifyRenewalDialog } from "./lead-closing";
import { PolicyCloseDialog } from "./policy-close";

/**
 * Inline status changer used in the table, cards and lead header. Picking
 * Closed Won opens the policy upload (only a checked policy makes a lead
 * Closed Won); Closed Lost or Auto Renewed on a lead whose renewal is near or
 * past first asks for next year's renewal date. Auto Renewed is offered only
 * for retail term life.
 */
export function StatusSelect({
  leadId,
  status,
  renewalDate = null,
  lead,
  clientName = "this lead",
  isAdmin = false,
  className,
}: {
  leadId: number;
  status: LeadStatus;
  /** The lead's renewal date, to suggest next year's when it is closed. */
  renewalDate?: string | null;
  /** Business type and product, to offer Auto Renewed only for retail term life. */
  lead?: { business_type: string; policy_product: string };
  clientName?: string;
  isAdmin?: boolean;
  className?: string;
}) {
  const options = lead ? statusesFor(lead, status) : LEAD_STATUSES.filter((s) => s !== "Auto Renewed" || s === status);
  const [closing, setClosing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(status);
  type Lost = { reason: LostReason; detail: string };
  const [verify, setVerify] = useState<{ status: LeadStatus; suggested: string; lost?: Lost } | null>(null);
  const [askLost, setAskLost] = useState(false);

  function save(next: LeadStatus, nextRenewalDate?: string, lost?: Lost) {
    startTransition(async () => {
      setOptimistic(next);
      const result = await safeAction(() => setLeadStatus(leadId, next, nextRenewalDate, lost));
      if (!result.ok) window.alert(result.error);
    });
  }

  function proceed(next: LeadStatus, lost?: Lost) {
    const suggested = rolloverForStatusChange({ status, renewal_date: renewalDate }, next, todayInBusinessTz());
    if (suggested) setVerify({ status: next, suggested, lost });
    else save(next, undefined, lost);
  }

  function changeStatus(value: string) {
    if (!LEAD_STATUSES.includes(value as LeadStatus) || value === optimistic) return;
    const next = value as LeadStatus;
    if (next === POLICY_GATED_STATUS) {
      setClosing(true);
      return;
    }
    if (next === LOST_STATUS) setAskLost(true);
    else proceed(next);
  }

  return (
    <>
    {askLost ? (
      <LostReasonDialog
        open
        clientName={clientName}
        onCancel={() => setAskLost(false)}
        onConfirm={(lost) => {
          setAskLost(false);
          proceed(LOST_STATUS, lost);
        }}
      />
    ) : null}
    {closing ? (
      <PolicyCloseDialog open leadId={leadId} clientName={clientName} isAdmin={isAdmin} onClose={() => setClosing(false)} />
    ) : null}
    {verify ? (
      <VerifyRenewalDialog
        open
        status={verify.status}
        currentDate={renewalDate}
        suggestedDate={verify.suggested}
        onCancel={() => setVerify(null)}
        onConfirm={(date) => {
          setVerify(null);
          save(verify.status, date, verify.lost);
        }}
      />
    ) : null}
    <Select.Root value={optimistic} onValueChange={changeStatus}>
      <Select.Trigger
        aria-label="Lead status"
        disabled={pending}
        className={cn(
          "group inline-flex h-7 w-[9.5rem] items-center justify-between gap-2 rounded-md border px-2 text-xs font-semibold shadow-xs outline-none transition-[color,background-color,border-color,box-shadow] focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-70",
          STATUS_STYLES[optimistic].badge,
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", STATUS_STYLES[optimistic].dot)} />
          <Select.Value />
        </span>
        <Select.Icon asChild>
          {pending ? (
            <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin opacity-70" />
          ) : (
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 opacity-60 transition-transform group-data-[state=open]:rotate-180" />
          )}
        </Select.Icon>
      </Select.Trigger>

      <Select.Portal>
        <Select.Content
          position="popper"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 min-w-40 overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg shadow-slate-900/10 ring-1 ring-black/5 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          <Select.Viewport className="max-h-[var(--radix-select-content-available-height)]">
            {options.map((value) => (
              <Select.Item
                key={value}
                value={value}
                className="relative flex min-h-9 w-full cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-2 pr-9 text-sm outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
              >
                <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", STATUS_STYLES[value].dot)} />
                <Select.ItemText>{value}</Select.ItemText>
                {value === POLICY_GATED_STATUS && value !== optimistic ? (
                  <span className="text-xs text-muted-foreground">upload policy</span>
                ) : null}
                <Select.ItemIndicator className="absolute right-2.5 inline-flex items-center text-primary">
                  <Check aria-hidden="true" className="size-4" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
    </>
  );
}
