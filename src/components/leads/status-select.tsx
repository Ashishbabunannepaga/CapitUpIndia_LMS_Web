"use client";

import { useOptimistic, useTransition } from "react";

import { setLeadStatus } from "@/app/(app)/leads/actions";
import type { LeadStatus } from "@/lib/database.types";
import { LEAD_STATUSES, STATUS_STYLES } from "@/lib/domain";
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

  return (
    <select
      aria-label="Lead status"
      value={optimistic}
      disabled={pending}
      onChange={(event) => {
        const next = event.target.value as LeadStatus;
        startTransition(async () => {
          setOptimistic(next);
          const result = await setLeadStatus(leadId, next);
          if (!result.ok) window.alert(result.error);
        });
      }}
      className={cn(
        "h-7 cursor-pointer appearance-none rounded-md border px-2 text-xs font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60",
        STATUS_STYLES[optimistic].badge,
        className,
      )}
    >
      {LEAD_STATUSES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}
