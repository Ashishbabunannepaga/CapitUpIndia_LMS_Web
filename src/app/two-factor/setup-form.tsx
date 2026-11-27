"use client";

import { useActionState, useMemo, useState } from "react";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import { renderSVG } from "uqr";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmSetup, disableTwoFactor, startSetup, type DisableState, type SetupState } from "./actions";

export function TwoFactorSetupForm() {
  const [started, startAction, starting] = useActionState<SetupState, FormData>(startSetup, {});
  const [confirmed, confirmAction, confirming] = useActionState<SetupState, FormData>(confirmSetup, {});
  const setup = started.setup;

  if (!setup) {
    return (
      <form action={startAction} className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="password">Your password</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        {started.error ? (
          <p role="alert" className="text-sm text-destructive">
            {started.error}
          </p>
        ) : null}
        <Button type="submit" disabled={starting} className="w-full">
          {starting ? <Loader2 className="animate-spin" /> : null}
          Continue
        </Button>
      </form>
    );
  }

  return (
    <div className="grid gap-6">
      <Step n={1} title="Scan this with your authenticator app">
        <QrCode value={setup.totpURI} />
        <p className="text-xs text-muted-foreground">
          Can&apos;t scan? Add an account by hand with this key:{" "}
          <span className="font-mono break-all text-foreground">{groupKey(setup.secret)}</span>. On this phone you can
          also{" "}
          <a href={setup.totpURI} className="underline underline-offset-4">
            open it in the app
          </a>
          .
        </p>
      </Step>
      <Step n={2} title="Keep your backup codes">
        <BackupCodes codes={setup.backupCodes} />
      </Step>
      <Step n={3} title="Type the code the app shows">
        <form action={confirmAction} className="grid gap-3">
          <Input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            placeholder="123456"
            required
            aria-label="6-digit code"
            className="text-center font-mono text-lg tracking-[0.3em]"
          />
          {confirmed.error ? (
            <p role="alert" className="text-sm text-destructive">
              {confirmed.error}
            </p>
          ) : null}
          <Button type="submit" disabled={confirming} className="w-full">
            {confirming ? <Loader2 className="animate-spin" /> : null}
            Turn on two-step sign-in
          </Button>
        </form>
      </Step>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <span className="grid size-6 place-items-center rounded-full bg-primary text-xs text-primary-foreground">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function QrCode({ value }: { value: string }) {
  const svg = useMemo(() => renderSVG(value, { border: 2 }), [value]);
  return (
    <div
      role="img"
      aria-label="QR code for your authenticator app"
      className="mx-auto w-48 rounded-lg bg-white p-2 [&_svg]:h-auto [&_svg]:w-full"
      // The SVG is generated locally from the otpauth link; no user HTML.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = `CapitUp LMS backup codes (each works once)\n\n${codes.join("\n")}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "capitup-lms-backup-codes.txt" });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        If you lose your phone, each of these opens your account once. Save them somewhere safe (not on the same
        phone). They are shown only now.
      </p>
      <ul className="grid grid-cols-2 gap-1.5 rounded-lg bg-muted p-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <Download />
          Download
        </Button>
      </div>
    </div>
  );
}

const groupKey = (secret: string) => secret.replace(/(.{4})/g, "$1 ").trim();

export function DisableTwoFactorForm() {
  const [state, action, pending] = useActionState<DisableState, FormData>(disableTwoFactor, {});
  return (
    <form action={action} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="password">Password to switch it off</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : null}
        Switch off two-step sign-in
      </Button>
    </form>
  );
}
