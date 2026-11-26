import type { Metadata } from "next";
import { Trash2 } from "lucide-react";

import { PageHeader } from "@/components/app-shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { requireSession } from "@/lib/auth";
import { listPlaybooks, OPEN_DAYS } from "@/server/data/playbooks";

import { addStepAction, createPlaybookAction, deletePlaybookAction, deleteStepAction, togglePlaybookAction } from "./actions";

export const metadata: Metadata = { title: "Playbooks" };

const when = (offset: number) =>
  offset === 0 ? "On the renewal date" : offset < 0 ? `${-offset} day${offset === -1 ? "" : "s"} before` : `${offset} day${offset === 1 ? "" : "s"} after`;

// The admin layout already requires an admin; the data functions check again.
export default async function PlaybooksPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { ctx, actor } = await requireSession();
  const [books, { error }] = await Promise.all([listPlaybooks(ctx, actor), searchParams]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Renewal playbooks"
        description={`Steps that turn into tasks for the lead's agent ${OPEN_DAYS} days before each is due, for every renewal, with the usual reminders and escalation.`}
      />
      {error ? <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      <p className="text-xs text-muted-foreground">
        Switching a playbook on creates tasks for renewals already inside its window (steps more than 3 days overdue are skipped). Closed Lost
        and Auto Renewed leads are left out. Use {"{client}"} in a title for the client&apos;s name.
      </p>

      {books.map((book) => (
        <section key={book.id} className="surface space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-medium">{book.name}</h2>
              <p className="text-xs text-muted-foreground">
                {book.applies_to === "any" ? "All leads" : `${book.applies_to} leads`} · {book.active ? "On" : "Off"}
              </p>
            </div>
            <div className="flex gap-2">
              <form action={togglePlaybookAction}>
                <input type="hidden" name="id" value={book.id} />
                {book.active ? null : <input type="hidden" name="active" value="on" />}
                <Button size="sm" variant={book.active ? "outline" : "default"}>
                  {book.active ? "Switch off" : "Switch on"}
                </Button>
              </form>
              <form action={deletePlaybookAction}>
                <input type="hidden" name="id" value={book.id} />
                <Button size="sm" variant="ghost" aria-label={`Delete ${book.name}`}>
                  <Trash2 className="size-4" />
                </Button>
              </form>
            </div>
          </div>

          <ol className="divide-y rounded-md border text-sm">
            {book.steps.map((step, i) => (
              <li key={step.id} className="flex items-start justify-between gap-3 px-3 py-2">
                <div>
                  <p>
                    <span className="mr-2 text-muted-foreground">{i + 1}.</span>
                    <span className="font-medium">{step.title}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {when(step.day_offset)} · {step.priority}
                    {step.tags ? ` · ${step.tags.split(",").join(", ")}` : ""}
                    {step.description ? ` · ${step.description}` : ""}
                  </p>
                </div>
                <form action={deleteStepAction}>
                  <input type="hidden" name="id" value={step.id} />
                  <Button size="sm" variant="ghost" aria-label={`Delete step ${i + 1}`}>
                    <Trash2 className="size-4" />
                  </Button>
                </form>
              </li>
            ))}
            {book.steps.length === 0 ? <li className="px-3 py-2 text-muted-foreground">No steps yet.</li> : null}
          </ol>

          <form action={addStepAction} className="grid gap-3 sm:grid-cols-6 sm:items-end">
            <input type="hidden" name="playbook_id" value={book.id} />
            <div className="space-y-1.5">
              <Label htmlFor={`offset-${book.id}`}>Days from renewal</Label>
              <Input id={`offset-${book.id}`} name="day_offset" type="number" min={-365} max={60} defaultValue={-20} required />
            </div>
            <div className="space-y-1.5 sm:col-span-3">
              <Label htmlFor={`title-${book.id}`}>Step</Label>
              <Input id={`title-${book.id}`} name="title" placeholder="Call {client} about the renewal" required maxLength={200} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`priority-${book.id}`}>Priority</Label>
              <NativeSelect id={`priority-${book.id}`} name="priority" defaultValue="P2">
                <option value="P1">P1</option>
                <option value="P2">P2</option>
                <option value="P3">P3</option>
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`tags-${book.id}`}>Tags</Label>
              <Input id={`tags-${book.id}`} name="tags" placeholder="renewal" maxLength={200} />
            </div>
            <div className="space-y-1.5 sm:col-span-5">
              <Label htmlFor={`desc-${book.id}`}>Details (optional)</Label>
              <Input id={`desc-${book.id}`} name="description" maxLength={2000} />
            </div>
            <Button type="submit">Add step</Button>
          </form>
        </section>
      ))}

      <section className="surface p-4 sm:p-5">
        <h2 className="mb-3 text-sm font-medium">New playbook</h2>
        <form action={createPlaybookAction} className="grid gap-3 sm:grid-cols-4 sm:items-end">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="pb-name">Name</Label>
            <Input id="pb-name" name="name" placeholder="Motor renewal" required maxLength={80} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pb-scope">Runs for</Label>
            <NativeSelect id="pb-scope" name="applies_to" defaultValue="any">
              <option value="any">All leads</option>
              <option value="Corporate">Corporate</option>
              <option value="Retail">Retail</option>
            </NativeSelect>
          </div>
          <Button type="submit">Create</Button>
        </form>
      </section>
    </div>
  );
}
