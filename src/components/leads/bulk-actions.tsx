"use client";

import { createContext, useContext, useMemo, useState, useTransition } from "react";
import { Download, Loader2, UserCog, X } from "lucide-react";

import { reassignLeads } from "@/app/(app)/leads/actions";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { safeAction } from "@/lib/safe-action";

type Selection = {
  selected: Set<number>;
  toggle: (id: number, on: boolean) => void;
  setAll: (on: boolean) => void;
  allIds: number[];
};

const SelectionContext = createContext<Selection | null>(null);

/**
 * Multi-select on the leads table (admins): row checkboxes, a select-all box
 * in the header, and a bar to reassign or export the ticked leads.
 */
export function LeadSelectionProvider({
  ids,
  agents,
  children,
}: {
  ids: number[];
  agents: { id: string; full_name: string }[];
  children: React.ReactNode;
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  // Rows that left the page (filter changed, lead reassigned away) drop out of the selection.
  const selected = useMemo(() => new Set([...picked].filter((id) => ids.includes(id))), [picked, ids]);
  const value = useMemo<Selection>(
    () => ({
      selected,
      allIds: ids,
      toggle: (id, on) =>
        setPicked((current) => {
          const next = new Set(current);
          if (on) next.add(id);
          else next.delete(id);
          return next;
        }),
      setAll: (on) => setPicked(on ? new Set(ids) : new Set()),
    }),
    [selected, ids],
  );
  return (
    <SelectionContext.Provider value={value}>
      {children}
      <BulkActionBar agents={agents} onDone={() => setPicked(new Set())} />
    </SelectionContext.Provider>
  );
}

function useSelection(): Selection {
  const selection = useContext(SelectionContext);
  if (!selection) throw new Error("Lead checkboxes need a LeadSelectionProvider.");
  return selection;
}

export function SelectAllCheckbox() {
  const { selected, allIds, setAll } = useSelection();
  const all = allIds.length > 0 && selected.size === allIds.length;
  return (
    <input
      type="checkbox"
      aria-label={all ? "Unselect all leads on this page" : "Select all leads on this page"}
      checked={all}
      ref={(el) => {
        if (el) el.indeterminate = selected.size > 0 && !all;
      }}
      onChange={(event) => setAll(event.target.checked)}
      className="size-4 cursor-pointer accent-primary"
    />
  );
}

export function RowCheckbox({ id, label }: { id: number; label: string }) {
  const { selected, toggle } = useSelection();
  return (
    <input
      type="checkbox"
      aria-label={`Select ${label}`}
      checked={selected.has(id)}
      onChange={(event) => toggle(id, event.target.checked)}
      className="size-4 cursor-pointer accent-primary"
    />
  );
}

function BulkActionBar({ agents, onDone }: { agents: { id: string; full_name: string }[]; onDone: () => void }) {
  const { selected } = useSelection();
  const [agent, setAgent] = useState("");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const ids = [...selected];

  if (ids.length === 0 && !message) return null;

  return (
    <div
      role="region"
      aria-label="Selected leads"
      className="fixed bottom-4 left-1/2 z-30 flex w-[calc(100vw-6rem)] max-w-3xl -translate-x-1/2 flex-wrap items-center gap-2 rounded-2xl border bg-card px-4 py-3 shadow-lift sm:bottom-6 lg:ml-32"
    >
      {ids.length > 0 ? (
        <>
          <p className="text-sm font-medium tabular-nums">{ids.length} selected</p>
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <NativeSelect
              size="sm"
              aria-label="Reassign to"
              value={agent}
              onChange={(event) => setAgent(event.target.value)}
              className="w-44"
            >
              <option value="">Reassign to…</option>
              <option value="unassigned">Unassigned</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.full_name}
                </option>
              ))}
            </NativeSelect>
            <Button
              type="button"
              size="sm"
              disabled={!agent || pending}
              onClick={() => {
                setMessage(null);
                startTransition(async () => {
                  const result = await safeAction(() => reassignLeads(ids, agent === "unassigned" ? null : agent));
                  if (result.ok) {
                    setMessage({ ok: true, text: result.message ?? "Reassigned." });
                    setAgent("");
                    onDone();
                  } else setMessage({ ok: false, text: result.error });
                });
              }}
            >
              {pending ? <Loader2 className="animate-spin" /> : <UserCog />}
              Reassign
            </Button>
            <Button asChild size="sm" variant="outline">
              <a href={`/leads/export?ids=${ids.join(",")}`} download>
                <Download />
                Export selected
              </a>
            </Button>
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={onDone} aria-label="Clear selection">
            <X />
          </Button>
        </>
      ) : null}
      {message ? (
        <p role="status" className={message.ok ? "flex w-full items-center justify-between text-xs text-success" : "w-full text-xs text-destructive"}>
          {message.text}
          {ids.length === 0 ? (
            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setMessage(null)} aria-label="Dismiss">
              <X className="size-3.5" />
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
