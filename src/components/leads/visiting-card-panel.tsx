"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, ImagePlus, Loader2, Maximize2 } from "lucide-react";

import { attachVisitingCard } from "@/app/(app)/leads/actions";
import { Button } from "@/components/ui/button";
import { cardFormData, prepareCardImages } from "@/lib/card-image";
import { cn } from "@/lib/utils";

type Props = {
  leadId: number;
  clientName: string;
  /** The card's image URL (carries the card id, so a replaced card is a new URL), or null when none is attached. */
  cardUrl: string | null;
  className?: string;
};

/**
 * The lead's visiting card, small enough to keep beside the lead while
 * meeting the client. Tap it for the full photo. Agents can attach or replace
 * the card from here (photos are shrunk in the browser before upload).
 */
export function VisitingCardPanel({ leadId, clientName, cardUrl, className }: Props) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function upload(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Use a photo of the card (JPEG, PNG or WebP).");
      return;
    }
    startTransition(async () => {
      try {
        const result = await attachVisitingCard(leadId, cardFormData(await prepareCardImages(file)));
        if (result.ok) router.refresh();
        else setError(result.error);
      } catch {
        setError("Could not read that image. Try a clearer JPEG or PNG photo.");
      } finally {
        if (input.current) input.current.value = "";
      }
    });
  }

  return (
    <section className={cn("rounded-2xl border bg-card shadow-card", className)} aria-label="Visiting card">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <h2 className="text-sm font-semibold">Visiting card</h2>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => input.current?.click()}
          className="h-7 px-2 text-xs"
        >
          {pending ? <Loader2 className="animate-spin" /> : cardUrl ? <Camera /> : <ImagePlus />}
          {pending ? "Uploading…" : cardUrl ? "Replace" : "Add card"}
        </Button>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => upload(event.target.files?.[0])}
        />
      </header>
      <div className="p-3">
        {cardUrl ? (
          <a
            href={`${cardUrl}&full=1`}
            target="_blank"
            rel="noopener"
            className="group relative block overflow-hidden rounded-lg border bg-muted/40"
            title="Open the full photo"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- same-origin route that checks access */}
            <img
              src={cardUrl}
              alt={`Visiting card for ${clientName}`}
              loading="lazy"
              decoding="async"
              className="max-h-56 w-full object-contain"
            />
            <span className="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-md bg-background/90 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground opacity-90 shadow-sm group-hover:text-foreground">
              <Maximize2 className="size-3" />
              Full size
            </span>
          </a>
        ) : (
          <p className="text-xs text-muted-foreground">
            No card yet. Add a photo of the client&apos;s visiting card to keep it handy on visits.
          </p>
        )}
        {error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
