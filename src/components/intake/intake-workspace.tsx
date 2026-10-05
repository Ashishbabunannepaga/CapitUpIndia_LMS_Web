"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Camera, ImageUp, Info, Loader2, Mic, MicOff, ScanLine, Sparkles, X } from "lucide-react";

import { extractLeadFromText, scanVisitingCard, type ExtractionResult } from "@/app/(app)/intake/actions";
import { LeadForm } from "@/components/leads/lead-form";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Props = {
  agents: { id: string; full_name: string }[];
  currentUserId: string;
  isAdmin: boolean;
  aiConfigured: boolean;
};

type Extracted = Extract<ExtractionResult, { ok: true }> & { previewUrl?: string; from: "text" | "card" };

// ---------------------------------------------------------------------------
// Speech input (Web Speech API, where the browser has it)
// ---------------------------------------------------------------------------

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
};

function getRecognition(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const onTextRef = useRef(onText);

  useEffect(() => {
    onTextRef.current = onText;
  });

  useEffect(() => {
    // Feature detection has to wait for the browser.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(getRecognition() !== null);
    return () => recognition.current?.stop();
  }, []);

  function toggle() {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const Ctor = getRecognition();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = "en-IN";
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (event) => {
      let text = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) text += event.results[i][0].transcript;
      }
      if (text.trim()) onTextRef.current(text.trim());
    };
    r.onerror = (event) => {
      setError(event.error === "not-allowed" ? "Allow microphone access to dictate." : "Dictation stopped.");
    };
    r.onend = () => setListening(false);
    recognition.current = r;
    setError(null);
    r.start();
    setListening(true);
  }

  return { supported, listening, toggle, error };
}

// ---------------------------------------------------------------------------
// Images: shrink before upload so phone photos stay well under the limit
// ---------------------------------------------------------------------------

async function shrinkImage(file: Blob, maxSide = 1600): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not read the image"))), "image/jpeg", 0.85),
  );
}

function WebcamCapture({ onCapture, onClose }: { onCapture: (blob: Blob) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 } } })
      .then((s) => {
        stream = s;
        if (video.current) video.current.srcObject = s;
      })
      .catch(() => setError("Camera not available. Allow camera access or upload a photo instead."));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")!.drawImage(v, 0, 0);
    canvas.toBlob((blob) => blob && onCapture(blob), "image/jpeg", 0.9);
  }

  return (
    <div className="space-y-2 rounded-lg border bg-black/90 p-2">
      {error ? (
        <p className="p-4 text-sm text-white">{error}</p>
      ) : (
        <video ref={video} autoPlay playsInline muted className="aspect-video w-full rounded bg-black object-contain" />
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" className="text-white hover:bg-white/10 hover:text-white" onClick={onClose}>
          Cancel
        </Button>
        {!error ? (
          <Button type="button" size="sm" onClick={capture}>
            <Camera />
            Capture
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export function IntakeWorkspace({ agents, currentUserId, isAdmin, aiConfigured }: Props) {
  const [notes, setNotes] = useState("");
  const [result, setResult] = useState<Extracted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"text" | "card" | null>(null);
  const [, startTransition] = useTransition();
  const [dragging, setDragging] = useState(false);
  const [webcam, setWebcam] = useState(false);
  const [version, setVersion] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const formAnchor = useRef<HTMLDivElement>(null);

  const dictation = useDictation((text) => setNotes((current) => (current ? `${current} ${text}` : text)));

  useEffect(() => () => {
    if (result?.previewUrl) URL.revokeObjectURL(result.previewUrl);
  }, [result?.previewUrl]);

  function show(next: Extracted) {
    setResult(next);
    setVersion((v) => v + 1);
    requestAnimationFrame(() => formAnchor.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function extractText() {
    setError(null);
    setBusy("text");
    startTransition(async () => {
      try {
        const res = await extractLeadFromText(notes);
        if (res.ok) show({ ...res, from: "text" });
        else setError(res.error);
      } catch {
        setError("Extraction failed. Try again.");
      } finally {
        setBusy(null);
      }
    });
  }

  function scan(file: Blob) {
    setError(null);
    setWebcam(false);
    if (!file.type.startsWith("image/")) {
      setError("Use a photo of the card (JPEG, PNG or WebP).");
      return;
    }
    setBusy("card");
    startTransition(async () => {
      try {
        const small = await shrinkImage(file);
        const formData = new FormData();
        formData.set("card", new File([small], "card.jpg", { type: "image/jpeg" }));
        const res = await scanVisitingCard(formData);
        if (res.ok) show({ ...res, from: "card", previewUrl: URL.createObjectURL(small) });
        else setError(res.error);
      } catch {
        setError("Could not read that image. Try a clearer JPEG or PNG photo.");
      } finally {
        setBusy(null);
      }
    });
  }

  const prefill = result
    ? Object.fromEntries(Object.entries(result.lead).map(([k, v]) => [k, String(v)]))
    : undefined;

  return (
    <div className="space-y-6">
      {!aiConfigured ? (
        <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <Info className="mt-0.5 size-4 shrink-0" />
          AI is not configured on this server yet, so notes use basic extraction and card scanning is unavailable.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="flex flex-col rounded-xl border bg-card p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold">Notes or dictation</h2>
              <p className="text-sm text-muted-foreground">Paste a WhatsApp message, call notes or meeting summary.</p>
            </div>
            {dictation.supported ? (
              <Button
                type="button"
                variant={dictation.listening ? "destructive" : "outline"}
                size="sm"
                onClick={dictation.toggle}
                aria-pressed={dictation.listening}
              >
                {dictation.listening ? <MicOff /> : <Mic />}
                {dictation.listening ? "Stop" : "Dictate"}
              </Button>
            ) : null}
          </div>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={8}
            maxLength={8000}
            className="min-h-44 flex-1"
            placeholder="e.g. Met Rajesh (Director) from Renee Systems today, 9845012345, rajesh@renee.in. Group health renewal due 15 Nov, 120 employees, currently with Star Health. Wants a quote by Friday."
          />
          {dictation.listening ? <p className="mt-2 text-xs text-urgent">Listening… speak naturally, then press Stop.</p> : null}
          {dictation.error ? <p className="mt-2 text-xs text-destructive">{dictation.error}</p> : null}
          <div className="mt-3 flex justify-end">
            <Button type="button" onClick={extractText} disabled={busy !== null || !notes.trim()}>
              {busy === "text" ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {busy === "text" ? "Extracting…" : "Extract lead"}
            </Button>
          </div>
        </section>

        <section className="flex flex-col rounded-xl border bg-card p-5 shadow-sm">
          <div className="mb-3">
            <h2 className="font-semibold">Visiting card</h2>
            <p className="text-sm text-muted-foreground">Drop a photo, upload one, or use your camera.</p>
          </div>
          {webcam ? (
            <WebcamCapture onCapture={scan} onClose={() => setWebcam(false)} />
          ) : (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file) scan(file);
              }}
              className={cn(
                "flex min-h-44 flex-1 flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-6 text-center transition-colors",
                dragging ? "border-primary bg-accent" : "border-border",
                !aiConfigured && "opacity-60",
              )}
            >
              {busy === "card" ? (
                <>
                  <Loader2 className="size-8 animate-spin text-primary" />
                  <p className="text-sm font-medium">Reading the card…</p>
                </>
              ) : (
                <>
                  <ScanLine className="size-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Drag a card photo here</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button type="button" variant="outline" size="sm" disabled={!aiConfigured || busy !== null} onClick={() => fileInput.current?.click()}>
                      <ImageUp />
                      Upload photo
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!aiConfigured || busy !== null}
                      onClick={() => {
                        // Phones open the camera app from a file input; desktops use the webcam.
                        if (window.matchMedia("(pointer: coarse)").matches) cameraInput.current?.click();
                        else setWebcam(true);
                      }}
                    >
                      <Camera />
                      Take photo
                    </Button>
                  </div>
                </>
              )}
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                tabIndex={-1}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) scan(file);
                  e.target.value = "";
                }}
              />
              <input
                ref={cameraInput}
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                tabIndex={-1}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) scan(file);
                  e.target.value = "";
                }}
              />
            </div>
          )}
        </section>
      </div>

      {error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <div ref={formAnchor} className="scroll-mt-6">
        {result ? (
          <div className="space-y-4">
            <div className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-accent/40 p-4 text-sm sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <p className="font-semibold">
                  {result.source === "ai" ? "Review the extracted lead" : "Basic extraction"}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {result.from === "card" ? "from the visiting card" : "from your notes"}. Nothing is saved until you press Save lead.
                  </span>
                </p>
                {result.notice ? <p className="text-amber-800">{result.notice}</p> : null}
                {result.dropped.length > 0 ? (
                  <p className="text-muted-foreground">
                    Left out: {result.dropped.join("; ")}.
                  </p>
                ) : null}
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setResult(null)}>
                <X />
                Discard
              </Button>
            </div>
            <LeadForm
              key={version}
              mode="create"
              agents={agents}
              currentUserId={currentUserId}
              isAdmin={isAdmin}
              prefill={prefill}
              card={result.cardPath && result.previewUrl ? { path: result.cardPath, previewUrl: result.previewUrl } : undefined}
            />
          </div>
        ) : (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            The extracted lead appears here for you to check and edit before saving. Existing companies are flagged
            before anything is created.
          </p>
        )}
      </div>
    </div>
  );
}
