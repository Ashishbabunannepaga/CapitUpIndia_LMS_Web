import type { Metadata } from "next";
import { Trash2 } from "lucide-react";

import { PageHeader } from "@/components/app-shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { requireSession } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { REMINDER_LADDER } from "@/server/data/task-reminders";
import { listTaskRules } from "@/server/data/task-rules";

import { deleteHolidayAction, deleteSlaRuleAction, saveHolidayAction, saveSlaRuleAction } from "./actions";

export const metadata: Metadata = { title: "Task rules" };

const h = (minutes: number) => {
  const hours = minutes / 60;
  return hours >= 48 && hours % 24 === 0 ? `${hours / 24} days` : `${Number(hours.toFixed(2))} h`;
};

// The admin layout already requires an admin; the data functions check again.
export default async function TaskRulesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { ctx, actor } = await requireSession();
  const [{ rules, holidays }, { error }] = await Promise.all([listTaskRules(ctx, actor), searchParams]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Task rules"
        description="When Task Grid reminds, nudges and escalates. Rules match a task's tag; anything else uses the default timings."
      />
      {error ? <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}

      <section className="surface space-y-4 p-4 sm:p-5">
        <h2 className="text-sm font-medium">Default timings</h2>
        <div className="grid gap-2 text-sm sm:grid-cols-3">
          {(["P1", "P2", "P3"] as const).map((p) => (
            <div key={p} className="rounded-md border p-3">
              <p className="font-medium">{p}</p>
              <p className="text-muted-foreground">
                Due soon {h(REMINDER_LADDER[p].soon / 60000)} before · nudge {h(REMINDER_LADDER[p].nudge / 60000)} late · escalate{" "}
                {h(REMINDER_LADDER[p].escalate / 60000)} late
              </p>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Nudges and escalations go out 09:00-21:00 IST, never on Sundays or the holidays below, and days off don&apos;t count as late.
        </p>
      </section>

      <section className="surface space-y-4 p-4 sm:p-5">
        <h2 className="text-sm font-medium">Rules by tag</h2>
        {rules.length ? (
          <ul className="divide-y rounded-md border text-sm">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span>
                  <span className="font-medium">{r.tag}</span> · {r.priority ?? "any priority"} · due soon {h(r.soon_minutes)} before · nudge{" "}
                  {h(r.nudge_minutes)} · escalate {h(r.escalate_minutes)}
                </span>
                <form action={deleteSlaRuleAction}>
                  <input type="hidden" name="id" value={r.id} />
                  <Button size="sm" variant="ghost" aria-label={`Delete the ${r.tag} rule`}>
                    <Trash2 className="size-4" />
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No rules yet. Every task uses the default timings.</p>
        )}
        <form action={saveSlaRuleAction} className="grid gap-3 sm:grid-cols-6 sm:items-end">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="rule-tag">Tag</Label>
            <Input id="rule-tag" name="tag" placeholder="claim" required maxLength={40} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rule-priority">Priority</Label>
            <NativeSelect id="rule-priority" name="priority" defaultValue="">
              <option value="">Any</option>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
              <option value="P3">P3</option>
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rule-soon">Due soon (h before)</Label>
            <Input id="rule-soon" name="soon_hours" type="number" min={0} max={168} step={0.25} defaultValue={1} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rule-nudge">Nudge (h late)</Label>
            <Input id="rule-nudge" name="nudge_hours" type="number" min={0.25} max={720} step={0.25} defaultValue={2} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rule-escalate">Escalate (h late)</Label>
            <Input id="rule-escalate" name="escalate_hours" type="number" min={0.25} max={720} step={0.25} defaultValue={8} required />
          </div>
          <Button type="submit" className="sm:col-span-6 sm:justify-self-start">
            Save rule
          </Button>
        </form>
      </section>

      <section className="surface space-y-4 p-4 sm:p-5">
        <h2 className="text-sm font-medium">Holidays</h2>
        {holidays.length ? (
          <ul className="divide-y rounded-md border text-sm">
            {holidays.map((d) => (
              <li key={d.date} className="flex items-center justify-between gap-3 px-3 py-2">
                <span>
                  <span className="font-medium">{formatDate(d.date)}</span> · {d.name}
                </span>
                <form action={deleteHolidayAction}>
                  <input type="hidden" name="date" value={d.date} />
                  <Button size="sm" variant="ghost" aria-label={`Delete ${d.name}`}>
                    <Trash2 className="size-4" />
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No holidays added. Sundays are always days off.</p>
        )}
        <form action={saveHolidayAction} className="grid gap-3 sm:grid-cols-4 sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="holiday-date">Date</Label>
            <Input id="holiday-date" name="date" type="date" required />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="holiday-name">Name</Label>
            <Input id="holiday-name" name="name" placeholder="Diwali" required maxLength={80} />
          </div>
          <Button type="submit">Add holiday</Button>
        </form>
      </section>
    </div>
  );
}
