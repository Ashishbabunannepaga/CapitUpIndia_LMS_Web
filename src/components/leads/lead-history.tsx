import {
  ArrowRightLeft,
  CheckCircle2,
  CircleDot,
  MessageCircle,
  MessageSquareText,
  Pencil,
  PlusCircle,
  RotateCcw,
  Tag,
  Timer,
  Trash2,
  UserCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { formatNoteTimestamp } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { HistoryItem, HistoryKind } from "@/server/data/history";

const ICONS: Record<HistoryKind, { icon: LucideIcon; tone: string }> = {
  created: { icon: PlusCircle, tone: "text-brand-700 bg-brand-50" },
  status: { icon: CircleDot, tone: "text-sky-700 bg-sky-50" },
  assigned: { icon: UserCheck, tone: "text-gold-800 bg-gold-50" },
  edited: { icon: Pencil, tone: "text-slate-700 bg-slate-100" },
  tags: { icon: Tag, tone: "text-violet-700 bg-violet-50" },
  note: { icon: MessageSquareText, tone: "text-brand-700 bg-brand-50" },
  task_created: { icon: Timer, tone: "text-orange-700 bg-orange-50" },
  task_done: { icon: CheckCircle2, tone: "text-green-700 bg-green-50" },
  task_reopened: { icon: RotateCcw, tone: "text-slate-700 bg-slate-100" },
  task_moved: { icon: ArrowRightLeft, tone: "text-orange-700 bg-orange-50" },
  contact: { icon: MessageCircle, tone: "text-green-700 bg-green-50" },
  deleted: { icon: Trash2, tone: "text-red-700 bg-red-50" },
};

/** The lead's history as a vertical timeline, newest first. */
export function LeadHistory({ items }: { items: HistoryItem[] }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>;
  return (
    <ol className="relative space-y-4 border-l border-border pl-6">
      {items.map((item, i) => {
        const { icon: Icon, tone } = ICONS[item.kind];
        return (
          <li key={`${item.at}-${item.kind}-${i}`} className="relative">
            <span className={cn("absolute top-0 -left-[37px] flex size-6 items-center justify-center rounded-full ring-4 ring-card", tone)}>
              <Icon className="size-3.5" />
            </span>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{item.who}</span> · {formatNoteTimestamp(item.at)}
            </p>
            <p className={cn("mt-0.5 text-sm", item.kind === "note" && "whitespace-pre-wrap")}>{item.summary}</p>
            {item.changes.length > 1 || (item.changes.length === 1 && item.kind !== "status" && item.kind !== "assigned") ? (
              <ul className="mt-1.5 space-y-0.5 rounded-md bg-muted/50 px-3 py-2 text-xs">
                {item.changes.map((change) => (
                  <li key={change.field} className="break-words">
                    <span className="text-muted-foreground">{change.label}:</span>{" "}
                    <span className="text-muted-foreground line-through">{change.from}</span> → <span>{change.to}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
