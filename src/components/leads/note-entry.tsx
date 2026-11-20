"use client";

import { useState, useTransition } from "react";
import { Loader2, Pencil } from "lucide-react";

import { editLeadNote, setLeadNotes } from "@/app/(app)/leads/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatNoteTimestamp } from "@/lib/dates";
import { tidyLeadNotes } from "@/lib/lead-notes";
import { safeAction } from "@/lib/safe-action";
import { cn } from "@/lib/utils";

/**
 * One entry in a lead's notes thread. Its writer (or an admin) can fix the
 * text in place; the name and time stay as written and an "edited" mark
 * shows it changed (the old text is kept in the lead's history).
 */
export function NoteEntry({
  note,
  unread,
  canEdit,
}: {
  note: { id: number; agent_name: string; created_at: string; edited_at: string | null; content: string };
  unread: boolean;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.content);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <li className={cn("rounded-lg border p-3 text-sm", unread && "border-primary/40 bg-accent/50")}>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">{note.agent_name}</span> - {formatNoteTimestamp(note.created_at)}
          {note.edited_at ? (
            <span title={`Edited ${formatNoteTimestamp(note.edited_at)}`} className="italic">
              {" "}
              · edited
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-1">
          {unread ? <span className="text-xs font-medium text-brand-700">New</span> : null}
          {canEdit && !editing ? (
            <button
              type="button"
              aria-label="Edit note"
              title="Edit note"
              onClick={() => {
                setDraft(note.content);
                setError(null);
                setEditing(true);
              }}
              className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Pencil className="size-3.5" />
            </button>
          ) : null}
        </span>
      </div>
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            startTransition(async () => {
              const result = await safeAction(() => editLeadNote(note.id, draft));
              if (result.ok) setEditing(false);
              else setError(result.error);
            });
          }}
        >
          <Textarea
            aria-label="Note text"
            value={draft}
            maxLength={5000}
            rows={3}
            required
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false);
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
            }}
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending || draft.trim() === ""}>
              {pending ? <Loader2 className="animate-spin" /> : null}
              Save note
            </Button>
          </div>
        </form>
      ) : (
        <p className="whitespace-pre-wrap">{note.content}</p>
      )}
    </li>
  );
}

/**
 * The lead's background notes field, editable in place by anyone who can edit
 * the lead. Repeated "[AI Import Update: ...]" lines from the old app's
 * imports show once, and saving removes the repeats for good.
 */
export function LeadNotesField({ leadId, notes, updatedAt }: { leadId: number; notes: string; updatedAt?: string }) {
  const shown = tidyLeadNotes(notes);
  const [editing, setEditing] = useState(false);
  // The lead's version when editing began: saving fails (instead of undoing
  // someone else's change) if the lead was saved in the meantime.
  const [version, setVersion] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (editing) {
    return (
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          startTransition(async () => {
            const result = await safeAction(() => setLeadNotes(leadId, draft, version));
            if (result.ok) setEditing(false);
            else setError(result.error);
          });
        }}
      >
        <Textarea
          aria-label="Lead notes"
          value={draft}
          maxLength={20000}
          rows={5}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setEditing(false);
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
          }}
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            Save notes
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className="flex items-start justify-between gap-2">
      {shown ? (
        <p className="text-sm whitespace-pre-wrap">{shown}</p>
      ) : (
        <p className="text-sm text-muted-foreground">No background notes yet.</p>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0"
        onClick={() => {
          setDraft(shown);
          setError(null);
          setVersion(updatedAt);
          setEditing(true);
        }}
      >
        <Pencil />
        {shown ? "Edit" : "Add"}
      </Button>
    </div>
  );
}
