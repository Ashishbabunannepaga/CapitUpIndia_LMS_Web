"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { verifyCode, type CodeState } from "../actions";

export function TwoFactorCodeForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState<CodeState, FormData>(verifyCode, {});
  const [kind, setKind] = useState<"totp" | "backup">("totp");
  const backup = kind === "backup";

  return (
    <form action={formAction} className="grid gap-4">
      <input type="hidden" name="next" value={next ?? ""} />
      <input type="hidden" name="kind" value={kind} />
      <div className="grid gap-2">
        <Label htmlFor="code">{backup ? "Backup code" : "6-digit code"}</Label>
        <Input
          key={kind}
          id="code"
          name="code"
          inputMode={backup ? "text" : "numeric"}
          autoComplete="one-time-code"
          pattern={backup ? undefined : "[0-9 ]{6,7}"}
          maxLength={backup ? 40 : 7}
          placeholder={backup ? "xxxxx-xxxxx" : "123456"}
          autoFocus
          required
          aria-invalid={Boolean(state.error)}
          className="text-center font-mono text-lg tracking-[0.3em]"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="trust" className="size-4 accent-primary" />
        Remember this device for 30 days
      </label>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}{" "}
          {state.expired ? (
            <Link href="/login" className="underline underline-offset-4">
              Sign in again
            </Link>
          ) : null}
        </p>
      ) : null}
      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? <Loader2 className="animate-spin" /> : null}
        Verify
      </Button>
      <button
        type="button"
        onClick={() => setKind(backup ? "totp" : "backup")}
        className="text-xs text-muted-foreground underline-offset-4 hover:underline"
      >
        {backup ? "Use the code from my app instead" : "Use a backup code instead"}
      </button>
    </form>
  );
}
