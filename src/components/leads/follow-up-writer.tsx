"use client";

import { useState, useTransition } from "react";
import { Check, Copy, Loader2, Mail, MessageCircle, RefreshCw, Sparkles } from "lucide-react";

import { generateFollowUp } from "@/app/(app)/leads/follow-up-actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FOLLOW_UP_TONES, type FollowUpTone } from "@/lib/ai/prompts";
import { mailtoHref, whatsappHref } from "@/lib/contact-links";
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
  const mail = draft ? mailtoHref(email, subject, draft) : null;

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
                <a href={wa} target="_blank" rel="noreferrer">
                  <MessageCircle />
                  WhatsApp
                </a>
              </Button>
            ) : null}
            {mail ? (
              <Button asChild size="sm" variant="outline">
                <a href={mail}>
                  <Mail />
                  Email
                </a>
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
          {!wa && !mail ? (
            <p className="text-xs text-muted-foreground">Add a phone or email to the primary POC to send it from here.</p>
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
