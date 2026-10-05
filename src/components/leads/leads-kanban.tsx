"use client";

import { useOptimistic, useState, useTransition } from "react";
import Link from "next/link";
import { GripVertical, User } from "lucide-react";

import { setLeadStatus } from "@/app/(app)/leads/actions";
import type { LeadStatus } from "@/lib/database.types";
import { CLOSED_STATUSES, LEAD_STATUSES, STATUS_STYLES } from "@/lib/domain";
import type { LeadWithAgent } from "@/lib/leads";
import { cn } from "@/lib/utils";
import { DuplicateBadge, RenewalDate } from "./lead-badges";
import { AgentName } from "./lead-views";

type Move = { id: number; status: LeadStatus };

/** Pipeline board: drag a card to another column to change its status. */
export function LeadsKanban({ leads, showAgent }: { leads: LeadWithAgent[]; showAgent: boolean }) {
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<LeadStatus | null>(null);
  const [board, moveOptimistic] = useOptimistic(leads, (current, move: Move) =>
    current.map((lead) => (lead.id === move.id ? { ...lead, status: move.status } : lead)),
  );

  const move = (id: number, status: LeadStatus) => {
    const lead = board.find((l) => l.id === id);
    if (!lead || lead.status === status) return;
    setError(null);
    startTransition(async () => {
      moveOptimistic({ id, status });
      const result = await setLeadStatus(id, status);
      if (!result.ok) setError(`${lead.client_name}: ${result.error}`);
    });
  };

  return (
    <div className="space-y-3">
      {error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        <div className="grid min-w-[1200px] grid-cols-6 gap-3">
          {LEAD_STATUSES.map((status) => {
            const column = board.filter((lead) => lead.status === status);
            return (
              <section
                key={status}
                aria-label={status}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDragOver(status);
                }}
                onDragLeave={() => setDragOver((s) => (s === status ? null : s))}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOver(null);
                  const id = Number(event.dataTransfer.getData("text/lead-id"));
                  if (id) move(id, status);
                }}
                className={cn(
                  "flex min-h-[420px] flex-col rounded-xl border bg-muted/40 transition-colors",
                  dragOver === status && "border-primary bg-accent",
                )}
              >
                <header className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <span className={cn("size-2 rounded-full", STATUS_STYLES[status].dot)} />
                    {status}
                  </div>
                  <span className="rounded-full bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {column.length}
                  </span>
                </header>
                <div className="flex flex-1 flex-col gap-2 p-2">
                  {column.map((lead) => (
                    <article
                      key={lead.id}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData("text/lead-id", String(lead.id));
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      className={cn(
                        "group cursor-grab rounded-lg border bg-card p-3 text-sm shadow-xs active:cursor-grabbing",
                        lead.is_duplicate && "border-red-200",
                      )}
                    >
                      <div className="flex items-start gap-1.5">
                        <GripVertical className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground" />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <Link
                            href={`/leads/${lead.id}`}
                            className="line-clamp-2 font-medium hover:text-primary hover:underline"
                          >
                            {lead.client_name}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {lead.policy_product} · {lead.type}
                          </p>
                          {lead.renewal_date ? (
                            <div className="text-xs">
                              <RenewalDate
                                date={lead.renewal_date}
                                closed={CLOSED_STATUSES.includes(lead.status)}
                                compact
                              />
                            </div>
                          ) : null}
                          {lead.poc_name ? (
                            <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                              <User className="size-3" />
                              {lead.poc_name}
                            </p>
                          ) : null}
                          <div className="flex flex-wrap items-center gap-1.5">
                            {lead.is_duplicate ? <DuplicateBadge label={lead.duplicate_label} /> : null}
                            {showAgent ? (
                              <span className="text-xs text-muted-foreground">
                                <AgentName name={lead.agent_name} />
                              </span>
                            ) : null}
                          </div>
                          {/* Keyboard and touch alternative to dragging. */}
                          <label className="sr-only" htmlFor={`move-${lead.id}`}>
                            Move {lead.client_name} to
                          </label>
                          <select
                            id={`move-${lead.id}`}
                            value={lead.status}
                            onChange={(event) => move(lead.id, event.target.value as LeadStatus)}
                            className="h-6 w-full rounded border bg-background px-1 text-xs text-muted-foreground lg:sr-only lg:focus:not-sr-only"
                          >
                            {LEAD_STATUSES.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </article>
                  ))}
                  {column.length === 0 ? (
                    <p className="px-2 py-6 text-center text-xs text-muted-foreground">Drop a lead here</p>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
