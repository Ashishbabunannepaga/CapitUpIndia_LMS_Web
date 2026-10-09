"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setUp, type SetupState } from "./actions";

export function SetupForm() {
  const [state, formAction, pending] = useActionState<SetupState, FormData>(setUp, {});
  return (
    <form action={formAction} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="code">Setup code</Label>
        <Input id="code" name="code" type="password" autoComplete="off" required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="full_name">Your name</Label>
        <Input id="full_name" name="full_name" defaultValue={state.fullName} required maxLength={120} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="email">Work email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" defaultValue={state.email} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required />
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? <Loader2 className="animate-spin" /> : null}
        Create admin account
      </Button>
    </form>
  );
}
