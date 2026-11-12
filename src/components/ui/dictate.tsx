"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Mic, MicOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Voice to text with the browser's own speech recognition (Web Speech API:
// Chrome, Edge, Safari and Android/iOS browsers; not Firefox). Nothing is
// sent to our server or to OpenAI; the browser's speech service does the
// transcription. Spoken words are added at the end of the text box, which
// the person can then correct before saving.

type SpeechResult = ArrayLike<{ transcript: string }> & { isFinal: boolean };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechResult> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
};

function recognitionClass(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const noop = () => () => {};

const ERRORS: Record<string, string> = {
  "not-allowed": "The microphone is blocked. Allow it for this site in the browser's settings.",
  "service-not-allowed": "The microphone is blocked. Allow it for this site in the browser's settings.",
  "no-speech": "Didn't catch anything. Tap the mic and speak again.",
  "audio-capture": "No microphone found.",
  network: "Dictation needs an internet connection.",
};

/** Adds `text` at the end of a text box the way typing would, so forms and React see the change. */
export function appendToField(field: HTMLTextAreaElement | HTMLInputElement, text: string) {
  const spoken = text.trim();
  if (!spoken) return;
  const current = field.value;
  const joiner = current === "" || /\s$/.test(current) ? "" : " ";
  const next = `${current}${joiner}${spoken}`.slice(0, field.maxLength > 0 ? field.maxLength : undefined);
  // Through the native setter, so a controlled React field also picks it up.
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
  if (setter) setter.call(field, next);
  else field.value = next;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.scrollTop = field.scrollHeight;
}

/** A mic button that types what the person says into `target`. */
export function DictateButton({
  target,
  className,
  lang = "en-IN",
}: {
  target: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  className?: string;
  lang?: string;
}) {
  const supported = useSyncExternalStore(noop, () => recognitionClass() !== null, () => true);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<Recognition | null>(null);

  useEffect(() => () => recognition.current?.stop(), []);

  const toggle = () => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const Ctor = recognitionClass();
    if (!Ctor) return;
    setError(null);
    const r = new Ctor();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (event) => {
      let pending = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          if (target.current) appendToField(target.current, text);
        } else {
          pending += text;
        }
      }
      setInterim(pending.trim());
    };
    r.onerror = (event) => {
      if (event.error !== "aborted") setError(ERRORS[event.error] ?? "Dictation stopped. Try again.");
    };
    r.onend = () => {
      setListening(false);
      setInterim("");
      recognition.current = null;
    };
    recognition.current = r;
    try {
      r.start();
      setListening(true);
      target.current?.focus();
    } catch {
      setError("Dictation could not start. Try again.");
    }
  };

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <Button
        type="button"
        size="sm"
        variant={listening ? "destructive" : "outline"}
        onClick={toggle}
        disabled={!supported}
        aria-pressed={listening}
        title={supported ? (listening ? "Stop dictation" : "Dictate: speak and it is typed for you") : "Dictation works in Chrome, Edge and Safari"}
      >
        {listening ? <MicOff /> : <Mic />}
        {listening ? "Stop" : "Dictate"}
      </Button>
      <p aria-live="polite" className={cn("min-w-0 truncate text-xs", error ? "text-destructive" : "text-muted-foreground")}>
        {error ??
          (listening ? (
            <>
              <span className="mr-1.5 inline-block size-2 animate-pulse rounded-full bg-destructive align-middle" aria-hidden="true" />
              {interim || "Listening… speak now"}
            </>
          ) : !supported ? (
            "Dictation isn't available in this browser."
          ) : null)}
      </p>
    </div>
  );
}
