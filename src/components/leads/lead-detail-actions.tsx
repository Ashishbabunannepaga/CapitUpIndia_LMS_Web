"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Send, Trash2, UserPlus } from "lucide-react";

import {
  addLeadContact,
  addLeadNote,
  assignLead,
  deleteLead,
  markNotesRead,
  resolveDuplicate,
} from "@/app/(app)/leads/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

function Feedback({ result }: { result: { ok: boolean; text: string } | null }) {
  if (!result) return null;
  return (
    <p role="status" className={result.ok ? "text-xs text-success" : "text-xs text-destructive"}>
      {result.text}
    </p>
  );
}

export function AssignAgentSelect({
  leadId,
  agentId,
  agents,
}: {
  leadId: number;
  agentId: string | null;
  agents: { id: string; full_name: string }[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <NativeSelect
        size="sm"
        aria-label="Assigned agent"
        defaultValue={agentId ?? ""}
        disabled={pending}
        onChange={(event) => {
          const value = event.target.value || null;
          setError(null);
          startTransition(async () => {
            const result = await assignLead(leadId, value);
            if (!result.ok) setError(result.error);
          });
        }}
      >
        <option value="">Unassigned</option>
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.full_name}
          </option>
        ))}
      </NativeSelect>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function AddNoteForm({ leadId }: { leadId: number }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      className="space-y-2"
      action={(formData) => {
        const content = String(formData.get("content") ?? "");
        setResult(null);
        startTransition(async () => {
          const res = await addLeadNote(leadId, content);
          if (res.ok) formRef.current?.reset();
          else setResult({ ok: false, text: res.error });
        });
      }}
    >
      <Label htmlFor="note-content" className="sr-only">
        Add a note
      </Label>
      <Textarea
        id="note-content"
        name="content"
        rows={3}
        maxLength={5000}
        required
        placeholder="Call notes, visit feedback or quote details"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) formRef.current?.requestSubmit();
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <Feedback result={result} />
        <Button type="submit" size="sm" disabled={pending} className="ml-auto">
          {pending ? <Loader2 className="animate-spin" /> : <Send />}
          Add note
        </Button>
      </div>
    </form>
  );
}

export function AddContactForm({ leadId }: { leadId: number }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  if (!open) {
    return (
      <div className="space-y-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          <UserPlus />
          Add contact
        </Button>
        <Feedback result={result} />
      </div>
    );
  }

  return (
    <form
      ref={formRef}
      className="space-y-3 rounded-lg border bg-muted/30 p-3"
      action={(formData) => {
        setResult(null);
        startTransition(async () => {
          const res = await addLeadContact(leadId, formData);
          if (res.ok) {
            formRef.current?.reset();
            setOpen(false);
            setResult({ ok: true, text: res.message ?? "Contact saved." });
          } else {
            setResult({ ok: false, text: res.error });
          }
        });
      }}
    >
      <p className="text-xs text-muted-foreground">
        Fills the primary POC if empty, then the secondary POC; otherwise the contact is added to the lead&apos;s notes.
        Existing contacts are never overwritten.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="contact-name">Name</Label>
          <Input id="contact-name" name="name" maxLength={120} autoFocus />
        </div>
        <div className="space-y-1">
          <Label htmlFor="contact-designation">Designation</Label>
          <Input id="contact-designation" name="designation" maxLength={120} placeholder="poc" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="contact-phone">Phone</Label>
          <Input id="contact-phone" name="phone" type="tel" maxLength={32} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="contact-email">Email</Label>
          <Input id="contact-email" name="email" type="email" maxLength={200} />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Feedback result={result} />
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : null}
          Save contact
        </Button>
      </div>
    </form>
  );
}

export function ResolveDuplicateButton({ leadId }: { leadId: number }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await resolveDuplicate(leadId);
            if (!result.ok) setError(result.error);
          })
        }
      >
        {pending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
        Mark as resolved
      </Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function DeleteLeadButton({ leadId, clientName, redirectTo }: { leadId: number; clientName: string; redirectTo?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="text-destructive hover:bg-red-50 hover:text-destructive"
      disabled={pending}
      onClick={() => {
        if (!window.confirm(`Delete ${clientName}? Its notes and reminders are deleted too. This can't be undone.`)) return;
        startTransition(async () => {
          const result = await deleteLead(leadId);
          if (!result.ok) window.alert(result.error);
          else if (redirectTo) router.push(redirectTo);
        });
      }}
    >
      {pending ? <Loader2 className="animate-spin" /> : <Trash2 />}
      Delete
    </Button>
  );
}

/** Marks this lead's notes as read once the page has been shown. */
export function MarkNotesReadOnView({ leadId, unread }: { leadId: number; unread: number }) {
  useEffect(() => {
    if (unread > 0) void markNotesRead(leadId);
  }, [leadId, unread]);
  return null;
}
