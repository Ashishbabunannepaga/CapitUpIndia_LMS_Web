"use client";

import { useRef, useState, useTransition } from "react";
import { KeyRound, Loader2, UserPlus } from "lucide-react";

import {
  addTeamMember,
  changeMemberActive,
  changeMemberRole,
  changeStaleDays,
  disableMember,
  memberBook,
  resetMemberPassword,
  type TeamResult,
} from "@/app/(app)/admin/team/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { safeAction } from "@/lib/safe-action";

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
          const outcome = await safeAction(() => addTeamMember(formData));
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
  takers = [],
}: {
  member: { id: string; full_name: string; role: "ADMIN" | "AGENT"; is_active: boolean };
  isSelf: boolean;
  /** Active people who can take over this person's leads and tasks. */
  takers?: { id: string; full_name: string }[];
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<TeamResult | null>(null);
  const [resetting, setResetting] = useState(false);
  // Disabling asks where their leads and open tasks go first.
  const [handover, setHandover] = useState<{ leads: number; tasks: number } | null>(null);
  const [taker, setTaker] = useState("");
  const act = (fn: () => Promise<TeamResult>) =>
    startTransition(async () => {
      const outcome = await safeAction(fn);
      setResult(outcome);
      if (outcome.ok) {
        setResetting(false);
        setHandover(null);
      }
    });
  const startDisable = () =>
    startTransition(async () => {
      setResult(null);
      const book = await safeAction(() => memberBook(member.id));
      if (!book.ok) return setResult(book);
      if (book.leads === 0 && book.tasks === 0) {
        const outcome = await safeAction(() => disableMember(member.id, "skip"));
        setResult(outcome);
        return;
      }
      setTaker("");
      setHandover({ leads: book.leads, tasks: book.tasks });
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
            onClick={() => (member.is_active ? startDisable() : act(() => changeMemberActive(member.id, true)))}
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
      {handover ? (
        <form
          className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            if (taker) act(() => disableMember(member.id, taker));
          }}
        >
          <p className="font-medium text-amber-900">
            {member.full_name} still has {handover.leads} lead{handover.leads === 1 ? "" : "s"} and {handover.tasks} open task
            {handover.tasks === 1 ? "" : "s"}.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`handover-${member.id}`} className="text-amber-900">
              Reassign all open leads and tasks to:
            </label>
            <NativeSelect
              id={`handover-${member.id}`}
              size="sm"
              required
              value={taker}
              onChange={(event) => setTaker(event.target.value)}
            >
              <option value="" disabled>
                Choose…
              </option>
              {takers.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.full_name}
                </option>
              ))}
              <option value="unassigned">Unassigned pool (open tasks come to you)</option>
              <option value="skip">Skip: keep them with {member.full_name} (admin override)</option>
            </NativeSelect>
          </div>
          {taker === "skip" ? (
            <p className="text-xs text-amber-900">
              Their leads stay assigned to someone who can&apos;t sign in. Renewal reminders go to admins, but the leads won&apos;t
              show under Unassigned.
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" type="submit" variant="destructive" disabled={pending || !taker}>
              {pending ? <Loader2 className="animate-spin" /> : null}
              {taker === "skip" ? "Disable without moving" : "Move and disable"}
            </Button>
            <Button size="sm" type="button" variant="ghost" disabled={pending} onClick={() => setHandover(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
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

/** The stale-lead threshold: open leads with no activity for this many days get a Stale badge. */
export function StaleDaysForm({ days }: { days: number }) {
  const [value, setValue] = useState(String(days));
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setResult(null);
        startTransition(async () => {
          const res = await safeAction(() => changeStaleDays(Number(value)));
          setResult(res.ok ? { ok: true, text: res.message ?? "Saved." } : { ok: false, text: res.error });
        });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="stale-days">Flag a lead as stale after</Label>
        <div className="flex items-center gap-2">
          <Input
            id="stale-days"
            type="number"
            min={1}
            max={365}
            step={1}
            required
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="w-24"
          />
          <span className="text-sm text-muted-foreground">days without a note, status change, task or contact</span>
        </div>
      </div>
      <Button type="submit" size="sm" disabled={pending || value === String(days)}>
        {pending ? <Loader2 className="animate-spin" /> : null}
        Save
      </Button>
      {result ? (
        <p role="status" className={result.ok ? "w-full text-xs text-success" : "w-full text-xs text-destructive"}>
          {result.text}
        </p>
      ) : null}
    </form>
  );
}
