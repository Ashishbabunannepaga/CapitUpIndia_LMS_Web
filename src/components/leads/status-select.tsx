"use client";

import { useOptimistic, useTransition } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { Select } from "radix-ui";

import { setLeadStatus } from "@/app/(app)/leads/actions";
import type { LeadStatus } from "@/lib/database.types";
import { LEAD_STATUSES, STATUS_STYLES } from "@/lib/domain";
import { safeAction } from "@/lib/safe-action";
import { cn } from "@/lib/utils";

/** Inline status changer used in the table, cards and lead header. */
export function StatusSelect({
  leadId,
  status,
  className,
}: {
  leadId: number;
  status: LeadStatus;
  className?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(status);

  function changeStatus(value: string) {
    if (!LEAD_STATUSES.includes(value as LeadStatus) || value === optimistic) return;
    const next = value as LeadStatus;

    startTransition(async () => {
      setOptimistic(next);
      const result = await safeAction(() => setLeadStatus(leadId, next));
      if (!result.ok) window.alert(result.error);
    });
  }

  return (
    <Select.Root value={optimistic} onValueChange={changeStatus}>
      <Select.Trigger
        aria-label="Lead status"
        disabled={pending}
        className={cn(
          "group inline-flex h-7 w-[7.5rem] items-center justify-between gap-2 rounded-md border px-2 text-xs font-semibold shadow-xs outline-none transition-[color,background-color,border-color,box-shadow] focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-70",
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
            {LEAD_STATUSES.map((value) => (
              <Select.Item
                key={value}
                value={value}
                className="relative flex min-h-9 w-full cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-2 pr-9 text-sm outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
              >
                <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", STATUS_STYLES[value].dot)} />
                <Select.ItemText>{value}</Select.ItemText>
                <Select.ItemIndicator className="absolute right-2.5 inline-flex items-center text-primary">
                  <Check aria-hidden="true" className="size-4" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
