"use client";

import { useState, useTransition } from "react";
import { Check, Copy, Loader2, Mail, MessageCircle, RefreshCw, Sparkles } from "lucide-react";

import { generateFollowUp } from "@/app/(app)/leads/follow-up-actions";
import { ContactLink } from "@/components/leads/contact-link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FOLLOW_UP_TONES, type FollowUpTone } from "@/lib/ai/prompts";
import { draftMailtoHref, gmailComposeHref, whatsappHref } from "@/lib/contact-links";
import { cn } from "@/lib/utils";

type Props = {
  leadId: number;
  clientName: string;
  product: string;
  phone: string;
  email: string;
};

/** AI follow-up drafts in four tones, editable, with WhatsApp, email and copy actions. */
export function FollowUpWriter({ leadId, clientName, product, phone, email }: Props) {
  const [tone, setTone] = useState<FollowUpTone>("professional");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function run(rephrase: boolean) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await generateFollowUp(leadId, tone, rephrase ? draft : undefined);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDraft(result.text);
      if (result.notice) setNotice(result.notice);
    });
  }

  const subject = `${clientName}: ${product} insurance`;
  const wa = draft ? whatsappHref(phone, draft) : null;
  // Email is always offered: with no POC email the agent types the address in their mail app.
  const mail = draft ? draftMailtoHref(email, subject, draft) : null;
  const gmail = draft ? gmailComposeHref(email, subject, draft) : null;
  const hasEmail = email.includes("@");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Tone">
        {(Object.keys(FOLLOW_UP_TONES) as FollowUpTone[]).map((key) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={tone === key}
            onClick={() => setTone(key)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              tone === key ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent",
            )}
          >
            {FOLLOW_UP_TONES[key].label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => run(false)} disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {draft ? "New draft" : "Write follow-up"}
        </Button>
        {draft ? (
          <Button type="button" size="sm" variant="outline" onClick={() => run(true)} disabled={pending}>
            <RefreshCw />
            Rephrase
          </Button>
        ) : null}
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {notice ? <p className="text-xs text-amber-700">{notice}</p> : null}

      {draft ? (
        <>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            aria-label="Follow-up draft"
          />
          <p className="text-right text-[11px] text-muted-foreground">{draft.trim().split(/\s+/).length} words</p>
          <div className="flex flex-wrap gap-2">
            {wa ? (
              <Button asChild size="sm" variant="outline">
                <ContactLink leadId={leadId} channel="whatsapp" withDraft href={wa} target="_blank" rel="noreferrer">
                  <MessageCircle />
                  WhatsApp
                </ContactLink>
              </Button>
            ) : null}
            {mail ? (
              <Button asChild size="sm" variant="outline">
                <ContactLink leadId={leadId} channel="email" withDraft href={mail}>
                  <Mail />
                  Email
                </ContactLink>
              </Button>
            ) : null}
            {gmail ? (
              <Button asChild size="sm" variant="outline">
                <ContactLink leadId={leadId} channel="email" withDraft href={gmail} target="_blank" rel="noreferrer">
                  <Mail />
                  Gmail
                </ContactLink>
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={async () => {
                await navigator.clipboard.writeText(draft);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          {!hasEmail ? (
            <p className="text-xs text-muted-foreground">
              This contact has no email yet, so add the address in the mail window, or save it on the lead with Edit.
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Drafts use the lead&apos;s status, notes and recent updates, stay under 50 words, and are signed with your name.
        </p>
      )}
    </div>
  );
}
