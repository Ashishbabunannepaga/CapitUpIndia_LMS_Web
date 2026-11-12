"use client";

import { useOptimistic, useState, useTransition } from "react";
import { Check, ClipboardCopy, MessageCircle, Tag } from "lucide-react";

import { setLeadTags } from "@/app/(app)/leads/actions";
import { Button } from "@/components/ui/button";
import type { LeadTag } from "@/lib/database.types";
import { whatsappHref } from "@/lib/contact-links";
import { LEAD_TAGS, TAG_STYLES } from "@/lib/domain";
import { safeAction } from "@/lib/safe-action";
import { cn } from "@/lib/utils";

import { ContactLink } from "./contact-link";

/** A small WhatsApp icon beside a phone number; opens wa.me in a new tab and logs the press. */
export function WhatsAppIconLink({ leadId, phone, className }: { leadId: number; phone: string; className?: string }) {
  const href = whatsappHref(phone);
  if (!href) return null;
  return (
    <ContactLink
      leadId={leadId}
      channel="whatsapp"
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`WhatsApp ${phone}`}
      title="Open WhatsApp chat"
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-green-600 transition-colors hover:bg-green-50 hover:text-green-700",
        className,
      )}
    >
      <MessageCircle className="size-3.5" />
    </ContactLink>
  );
}

/** Copies a plain-text snapshot of the lead, ready to paste into WhatsApp or email. */
export function CopySummaryButton({ summary }: { summary: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      type="button"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(summary);
          setState("copied");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 2000);
      }}
    >
      {state === "copied" ? <Check /> : <ClipboardCopy />}
      {state === "copied" ? "Copied" : state === "failed" ? "Copy blocked" : "Copy summary"}
    </Button>
  );
}

/** Tag chips on the lead page: tap a tag to add or remove it. */
export function LeadTagsEditor({ leadId, tags }: { leadId: number; tags: LeadTag[] }) {
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [current, setOptimistic] = useOptimistic(tags);

  function toggle(tag: LeadTag) {
    const next = current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag];
    setError(null);
    startTransition(async () => {
      setOptimistic(next);
      const result = await safeAction(() => setLeadTags(leadId, next));
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Tag className="size-3.5 text-muted-foreground" aria-hidden="true" />
      {LEAD_TAGS.map((tag) => {
        const on = current.includes(tag);
        return (
          <button
            key={tag}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(tag)}
            className={cn(
              "rounded-md border px-2 py-0.5 text-xs font-medium transition-colors",
              on ? TAG_STYLES[tag] : "border-dashed text-muted-foreground hover:border-solid hover:text-foreground",
            )}
          >
            {on ? tag : `+ ${tag}`}
          </button>
        );
      })}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
