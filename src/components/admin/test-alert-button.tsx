"use client";

import { useState, useTransition } from "react";
import { BellRing } from "lucide-react";

import { sendTestAlert, type TestAlertResult } from "@/app/(app)/admin/health/actions";
import { Button } from "@/components/ui/button";
import { safeAction } from "@/lib/safe-action";

export function TestAlertButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<TestAlertResult | null>(null);
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => startTransition(async () => setResult(await safeAction(() => sendTestAlert())))}
      >
        <BellRing className="size-4" />
        {pending ? "Sending..." : "Send test alert"}
      </Button>
      {result ? (
        <p role="status" className={result.ok ? "text-xs text-success" : "text-xs text-destructive"}>
          {result.ok ? result.message : result.error}
        </p>
      ) : null}
    </div>
  );
}
