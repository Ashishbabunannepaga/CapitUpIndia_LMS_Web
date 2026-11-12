"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { CalendarClock, Link2, ListTodo, Loader2, Plus, Save, Users, X } from "lucide-react";

import { createTask, findLeadsForTask, updateTask } from "@/app/(app)/my-day/actions";
import { Button } from "@/components/ui/button";
import { ClockToggle, TimeField } from "@/components/ui/clock";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { EVENT_KIND_LABELS, EVENT_KINDS, type EventKind } from "@/lib/domain";
import { safeAction } from "@/lib/safe-action";
import { cn } from "@/lib/utils";

export type LeadRef = { id: number; client_name: string };

/** A task or meeting as the edit form needs it. Date and time are business time (India). */
export type EditableTask = {
  id: number;
  title: string;
  kind: EventKind;
  notes: string;
  date: string;
  time: string;
  lead: LeadRef | null;
  assigneeId: string | null;
};

type Assignee = { id: string; full_name: string };

/** Search-as-you-type picker for the lead a task or meeting is about. Submits `lead_id`. */
export function LeadPicker({ defaultLead = null }: { defaultLead?: LeadRef | null }) {
  const [lead, setLead] = useState<LeadRef | null>(defaultLead);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; leads: LeadRef[] }>({ query: "", leads: [] });
  const [open, setOpen] = useState(false);
  const requestId = useRef(0);
  const term = query.trim();

  useEffect(() => {
    if (term.length < 2) return;
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      try {
        const leads = await findLeadsForTask(term);
        if (id === requestId.current) setResults({ query: term, leads });
      } catch {
        // Offline for a moment: the list just stays empty.
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [term]);

  const shown = term.length >= 2 && results.query === term ? results.leads : [];

  if (lead) {
    return (
      <div className="flex h-9 min-w-0 items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm">
        <input type="hidden" name="lead_id" value={lead.id} />
        <Link2 className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{lead.client_name}</span>
        <button
          type="button"
          aria-label={`Unlink ${lead.client_name}`}
          onClick={() => setLead(null)}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative min-w-0">
      <input type="hidden" name="lead_id" value="" />
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Link a lead (optional): type a company name"
        aria-label="Linked lead"
        autoComplete="off"
        role="combobox"
        aria-expanded={open && shown.length > 0}
      />
      {open && term.length >= 2 ? (
        <ul
          role="listbox"
          className="absolute top-full right-0 left-0 z-50 mt-1 max-h-60 overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-lift"
        >
          {shown.length === 0 ? (
            <li className="px-2 py-1.5 text-muted-foreground">{results.query === term ? "No matching leads." : "Searching…"}</li>
          ) : (
            shown.map((match) => (
              <li key={match.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  // mousedown, so the pick lands before the input's blur closes the list.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setLead(match);
                    setQuery("");
                    setOpen(false);
                  }}
                  className="block w-full truncate rounded px-2 py-1.5 text-left hover:bg-accent"
                >
                  {match.client_name}
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

function KindSwitch({ value, onChange }: { value: EventKind; onChange: (kind: EventKind) => void }) {
  return (
    <div role="radiogroup" aria-label="Type" className="inline-flex h-9 shrink-0 items-center rounded-md border bg-muted p-0.5 text-xs font-medium">
      <input type="hidden" name="kind" value={value} />
      {EVENT_KINDS.map((kind) => {
        const Icon = kind === "meeting" ? Users : ListTodo;
        return (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={value === kind}
            onClick={() => onChange(kind)}
            className={cn(
              "inline-flex h-full items-center gap-1.5 rounded px-3 transition-colors",
              value === kind ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {EVENT_KIND_LABELS[kind]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Plan or edit a task or meeting: what, when (with the 12h/24h switch),
 * details, the lead it is about and, for admins, who it is for. Used on My
 * Day, the calendar, a lead's page (`fixedLead`) and in the edit dialog.
 * `compact` keeps details and the lead link behind a "More" button.
 */
export function TaskForm({
  today,
  task,
  assignees,
  currentUserId,
  fixedLead,
  compact = false,
  defaultKind = "task",
  onDone,
}: {
  today: string;
  /** Present when editing. */
  task?: EditableTask;
  /** Present for admins, who can plan for anyone active. */
  assignees?: Assignee[];
  currentUserId: string;
  /** On a lead's page: the lead every new entry is linked to. */
  fixedLead?: LeadRef;
  compact?: boolean;
  defaultKind?: EventKind;
  onDone?: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<EventKind>(task?.kind ?? defaultKind);
  const [expanded, setExpanded] = useState(!compact || Boolean(task?.notes || task?.lead));
  // Remounting the time field after a save puts it back to its default.
  const [round, setRound] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const editing = Boolean(task);
  const assigneeValue = task?.assigneeId ?? currentUserId;
  const assigneeList =
    assignees && task?.assigneeId && !assignees.some((a) => a.id === task.assigneeId)
      ? [...assignees, { id: task.assigneeId, full_name: "Current owner" }]
      : assignees;

  return (
    <form
      ref={formRef}
      className="space-y-2"
      onSubmit={(event) => {
        // Not a form action: React would clear the fields even when saving fails.
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        setError(null);
        startTransition(async () => {
          const result = await safeAction(() => (task ? updateTask(task.id, formData) : createTask(formData)));
          if (!result.ok) {
            setError(result.error);
            return;
          }
          if (!task) {
            formRef.current?.reset();
            setRound((n) => n + 1);
            if (compact) setExpanded(false);
          }
          onDone?.();
        });
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <KindSwitch value={kind} onChange={setKind} />
        <Input
          name="title"
          required
          maxLength={300}
          defaultValue={task?.title}
          placeholder={
            kind === "meeting"
              ? "e.g. Scheduled a meet with Rajesh (XYZ Pvt Ltd) at their office"
              : "Plan a task, e.g. Call Rajesh about the GMC quote"
          }
          aria-label={kind === "meeting" ? "Meeting" : "Task"}
          className="min-w-0 flex-1 basis-60"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          name="date"
          type="date"
          required={editing}
          defaultValue={task?.date ?? today}
          aria-label="Date"
          className="w-auto min-w-0 flex-1 sm:flex-none"
        />
        <TimeField key={round} name="time" defaultValue={task?.time ?? "10:00"} />
        <ClockToggle />
        {assigneeList ? (
          <NativeSelect
            name="assignee"
            aria-label="Assign to"
            defaultValue={assigneeValue}
            className="w-full sm:w-auto sm:min-w-40 sm:flex-1"
          >
            {assigneeList.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id === currentUserId ? `Me (${a.full_name})` : a.full_name}
              </option>
            ))}
          </NativeSelect>
        ) : null}
      </div>

      {expanded ? (
        <div className="space-y-2">
          <Textarea
            name="notes"
            rows={2}
            maxLength={5000}
            defaultValue={task?.notes}
            placeholder={kind === "meeting" ? "Agenda, venue, who is attending (optional)" : "Details (optional)"}
            aria-label="Details"
          />
          {fixedLead ? <input type="hidden" name="lead_id" value={fixedLead.id} /> : <LeadPicker key={round} defaultLead={task?.lead} />}
        </div>
      ) : fixedLead ? (
        <input type="hidden" name="lead_id" value={fixedLead.id} />
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {!expanded ? (
          <Button type="button" variant="ghost" size="sm" className="mr-auto" onClick={() => setExpanded(true)}>
            <Plus />
            Details or lead
          </Button>
        ) : null}
        {onDone && editing ? (
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : editing ? <Save /> : <CalendarClock />}
          {editing ? "Save changes" : kind === "meeting" ? "Add meeting" : "Add task"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
