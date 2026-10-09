"use client";

import { useRef, useState, useTransition } from "react";
import { KeyRound, Loader2, UserPlus } from "lucide-react";

import {
  addTeamMember,
  changeMemberActive,
  changeMemberRole,
  resetMemberPassword,
  type TeamResult,
} from "@/app/(app)/admin/team/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

function Feedback({ result }: { result: TeamResult | null }) {
  if (!result) return null;
  return (
    <p role="status" className={result.ok ? "text-xs text-success" : "text-xs text-destructive"}>
      {result.ok ? result.message : result.error}
    </p>
  );
}

/** Creates a sign-in account. There is no public sign-up; this is the only way in. */
export function AddMemberForm() {
  const form = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<TeamResult | null>(null);
  return (
    <form
      ref={form}
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto_auto] lg:items-end"
      action={(formData) =>
        startTransition(async () => {
          const outcome = await addTeamMember(formData);
          setResult(outcome);
          if (outcome.ok) form.current?.reset();
        })
      }
    >
      <div className="grid gap-1.5">
        <Label htmlFor="new_full_name">Full name</Label>
        <Input id="new_full_name" name="full_name" required maxLength={120} autoComplete="off" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="new_email">Work email</Label>
        <Input id="new_email" name="email" type="email" required autoComplete="off" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="new_password">First password</Label>
        <Input id="new_password" name="password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="new_role">Role</Label>
        <NativeSelect id="new_role" name="role" defaultValue="AGENT">
          <option value="AGENT">Agent</option>
          <option value="ADMIN">Admin</option>
        </NativeSelect>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : <UserPlus />}
        Add person
      </Button>
      <div className="sm:col-span-2 lg:col-span-5">
        <Feedback result={result} />
      </div>
    </form>
  );
}

/** Role, access and password controls for one person. Admins cannot lock themselves out here. */
export function MemberControls({
  member,
  isSelf,
}: {
  member: { id: string; full_name: string; role: "ADMIN" | "AGENT"; is_active: boolean };
  isSelf: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<TeamResult | null>(null);
  const [resetting, setResetting] = useState(false);
  const act = (fn: () => Promise<TeamResult>) =>
    startTransition(async () => {
      const outcome = await fn();
      setResult(outcome);
      if (outcome.ok) setResetting(false);
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          size="sm"
          aria-label={`Role for ${member.full_name}`}
          defaultValue={member.role}
          disabled={pending || isSelf}
          onChange={(event) => act(() => changeMemberRole(member.id, event.target.value))}
        >
          <option value="AGENT">Agent</option>
          <option value="ADMIN">Admin</option>
        </NativeSelect>
        {isSelf ? null : (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => act(() => changeMemberActive(member.id, !member.is_active))}
          >
            {member.is_active ? "Disable" : "Enable"}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setResetting((open) => !open)}>
          <KeyRound />
          Reset password
        </Button>
        {pending ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
      </div>
      {resetting ? (
        <form
          className="flex flex-wrap items-center gap-2"
          action={(formData) => act(() => resetMemberPassword(member.id, formData))}
        >
          <Input
            name="password"
            type="password"
            aria-label={`New password for ${member.full_name}`}
            placeholder="New password"
            required
            minLength={8}
            maxLength={128}
            autoComplete="new-password"
            className="h-8 w-48"
          />
          <Button size="sm" type="submit" disabled={pending}>
            Save password
          </Button>
        </form>
      ) : null}
      <Feedback result={result} />
    </div>
  );
}
