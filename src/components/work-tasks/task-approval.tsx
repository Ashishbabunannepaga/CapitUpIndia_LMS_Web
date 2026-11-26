"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";

import { decideApprovalAction } from "@/app/(app)/tasks/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { safeAction } from "@/lib/safe-action";

/** Approve / Reject for an admin on a pending approval request. A rejection needs a reason. */
export function ApprovalPanel({ taskId, askedBy }: { taskId: number; askedBy: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function decide(decision: "approved" | "rejected") {
    setError(null);
    if (decision === "rejected" && !note.trim()) {
      setError("Add a reason, then press Reject.");
      return;
    }
    start(async () => {
      const result = await safeAction(() => decideApprovalAction(taskId, decision, note));
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <section className="surface space-y-3 border-amber-300 p-4">
      <div>
        <h2 className="text-sm font-medium">Approval needed</h2>
        <p className="text-xs text-muted-foreground">{askedBy} is waiting on your decision.</p>
      </div>
      <Textarea
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note or reason (required to reject)"
        maxLength={1000}
        aria-label="Approval note"
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={pending} onClick={() => decide("approved")}>
          <Check className="size-4" /> Approve
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => decide("rejected")}>
          <X className="size-4" /> Reject
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
