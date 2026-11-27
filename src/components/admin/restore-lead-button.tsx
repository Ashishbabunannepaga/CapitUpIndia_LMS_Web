"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { RotateCcw } from "lucide-react";

import { restoreLead, type RestoreResult } from "@/app/(app)/admin/deleted/actions";
import { Button } from "@/components/ui/button";
import { safeAction } from "@/lib/safe-action";

export function RestoreLeadButton({ leadId, clientName }: { leadId: number; clientName: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<RestoreResult | null>(null);
  if (result?.ok) {
    return (
      <Link href={`/leads/${result.leadId}`} className="text-xs font-medium text-success underline-offset-2 hover:underline">
        Restored. Open lead
      </Link>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        aria-label={`Restore ${clientName}`}
        onClick={() => startTransition(async () => setResult(await safeAction(() => restoreLead(leadId))))}
      >
        <RotateCcw className="size-4" />
        {pending ? "Restoring..." : "Restore"}
      </Button>
      {result && !result.ok ? (
        <p role="status" className="text-xs text-destructive">
          {result.error}
        </p>
      ) : null}
    </div>
  );
}
