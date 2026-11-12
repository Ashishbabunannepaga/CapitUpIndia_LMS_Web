"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BellRing, Loader2, X } from "lucide-react";

import { removePushSubscription, savePushSubscription } from "@/app/(app)/notifications/actions";
import { Button } from "@/components/ui/button";
import { safeAction } from "@/lib/safe-action";
import { cn } from "@/lib/utils";

// Browser push notifications. The person allows them once per browser; the
// browser then gets a push subscription (signed with our VAPID public key)
// that the server stores, and the per-minute job pushes every new bell item
// to it, even when the LMS is closed. public/sw.js shows them.
//
// Without the VAPID secrets on the server (publicKey null) the same
// permission still gives alerts while an LMS tab is open: the bell shows a
// system notification when a new item arrives.

const DISMISSED_KEY = "capitup.push.dismissedAt";
const ASK_AGAIN_AFTER_MS = 14 * 86_400_000;

export type PushSupport = "checking" | "supported" | "ios-needs-install" | "unsupported";

const noSubscribe = () => () => {};

function detectSupport(): PushSupport {
  if (typeof window === "undefined") return "checking";
  const hasApis = "serviceWorker" in navigator && "Notification" in window;
  if (hasApis && "PushManager" in window) return "supported";
  // iPhone and iPad allow web push only for sites added to the Home Screen.
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios) return "ios-needs-install";
  return hasApis ? "supported" : "unsupported";
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const current = subscription.options?.applicationServerKey;
  if (!current) return true; // Older browsers don't say; assume it matches.
  const a = new Uint8Array(current);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

/** Subscribes this browser (once allowed) and tells the server. */
async function syncSubscription(publicKey: string): Promise<string | null> {
  const reg = await registration();
  if (!("pushManager" in reg)) return null;
  let subscription = await reg.pushManager.getSubscription();
  if (subscription && !sameKey(subscription, publicKey)) {
    // The server's key changed: the old subscription can no longer be used.
    await subscription.unsubscribe().catch(() => undefined);
    subscription = null;
  }
  subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const json = subscription.toJSON();
  const result = await safeAction(() =>
    savePushSubscription({ endpoint: subscription.endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" } }),
  );
  return result.ok ? null : result.error;
}

/** Push state for this browser, and the actions to turn it on or off. */
export function usePush(publicKey: string | null) {
  // Read from the browser after hydration; the server renders "checking".
  const support = useSyncExternalStore(noSubscribe, detectSupport, () => "checking" as PushSupport);
  const browserPermission = useSyncExternalStore(
    noSubscribe,
    () => ("Notification" in window ? Notification.permission : "default"),
    () => "default" as NotificationPermission,
  );
  const [answered, setAnswered] = useState<NotificationPermission | null>(null);
  const permission = answered ?? browserPermission;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (support !== "supported") return;
    // Already allowed: make sure the server has this browser (it may be new,
    // the key may have changed, or the subscription may have been renewed).
    if (Notification.permission === "granted") {
      const work = publicKey ? syncSubscription(publicKey) : registration().then(() => null);
      work.then((message) => message && setError(message)).catch(() => undefined);
    }
  }, [publicKey, support]);

  const enable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await Notification.requestPermission();
      setAnswered(answer);
      if (answer !== "granted") {
        if (answer === "denied") setError("Notifications are blocked. Allow them for this site in the browser's settings.");
        return;
      }
      if (publicKey) {
        const message = await syncSubscription(publicKey);
        if (message) setError(message);
      } else {
        await registration();
      }
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification("Notifications are on", {
        body: "Renewal reminders and new assignments will show up here.",
        icon: "/capitup-logo.png",
        tag: "push-enabled",
      });
    } catch {
      setError("Couldn't turn notifications on in this browser. Try again.");
    } finally {
      setBusy(false);
    }
  }, [publicKey]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const subscription = await reg?.pushManager?.getSubscription();
      if (subscription) {
        await safeAction(async () => {
          await removePushSubscription(subscription.endpoint);
          return { ok: true as const };
        });
        await subscription.unsubscribe();
      }
      setError("Push is off for this browser. To stop all alerts, also block notifications in the browser's site settings.");
    } finally {
      setBusy(false);
    }
  }, []);

  return { support, permission, busy, error, enable, disable, serverPush: Boolean(publicKey) };
}

/** A one-line invitation at the top of the page until the person decides. */
function dismissedRecently(): boolean {
  try {
    return Date.now() - Number(window.localStorage.getItem(DISMISSED_KEY) ?? 0) < ASK_AGAIN_AFTER_MS;
  } catch {
    return false;
  }
}

export function PushBanner({ publicKey }: { publicKey: string | null }) {
  const push = usePush(publicKey);
  const dismissedBefore = useSyncExternalStore(noSubscribe, dismissedRecently, () => true);
  const [dismissedNow, setDismissedNow] = useState(false);
  const hidden = dismissedBefore || dismissedNow;

  if (hidden || push.support !== "supported" || (push.permission !== "default" && !push.error)) return null;

  const dismiss = () => {
    setDismissedNow(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {
      // Shown again next visit; harmless.
    }
  };

  return (
    <div
      role="region"
      aria-label="Notifications"
      className="mb-4 flex flex-col gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900 sm:flex-row sm:items-center dark:border-brand-900 dark:bg-brand-950/40 dark:text-brand-100"
    >
      <BellRing className="hidden size-5 shrink-0 sm:block" />
      <p className="min-w-0 flex-1">
        {push.error ?? (
          <>
            <span className="font-medium">Get alerts on this device.</span> Renewal reminders and newly assigned leads pop up as
            notifications{push.serverPush ? ", even when the LMS is closed" : " while the LMS is open"}.
          </>
        )}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        {push.permission === "default" ? (
          <Button type="button" size="sm" onClick={push.enable} disabled={push.busy}>
            {push.busy ? <Loader2 className="animate-spin" /> : <BellRing />}
            Turn on
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" onClick={dismiss} aria-label="Not now">
          {push.permission === "default" ? "Not now" : <X />}
        </Button>
      </div>
    </div>
  );
}

/** The bell panel's footer: whether this device gets alerts, and a switch. */
export function PushStatus({ publicKey, className }: { publicKey: string | null; className?: string }) {
  const push = usePush(publicKey);
  const [off, setOff] = useState(false);
  if (push.support === "checking" || push.support === "unsupported") return null;

  let text: string;
  let action: React.ReactNode = null;
  if (push.support === "ios-needs-install") {
    text = "On iPhone: Share > Add to Home Screen, open the LMS from there, then turn on alerts.";
  } else if (push.permission === "denied") {
    text = "Alerts are blocked for this site in the browser's settings.";
  } else if (push.permission === "granted" && !off) {
    text = push.serverPush ? "Alerts are on for this device." : "Alerts are on while the LMS is open.";
    if (push.serverPush) {
      action = (
        <button
          type="button"
          className="font-medium underline-offset-2 hover:underline"
          disabled={push.busy}
          onClick={async () => {
            await push.disable();
            setOff(true);
          }}
        >
          Turn off
        </button>
      );
    }
  } else {
    text = "Get these as alerts on this device.";
    action = (
      <button
        type="button"
        className="font-medium text-primary underline-offset-2 hover:underline"
        disabled={push.busy}
        onClick={async () => {
          setOff(false);
          await push.enable();
        }}
      >
        Turn on
      </button>
    );
  }

  return (
    <div className={cn("flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground", className)}>
      <span className="flex min-w-0 items-center gap-1.5">
        <BellRing className="size-3.5 shrink-0" />
        <span>{push.error && push.permission === "granted" ? push.error : text}</span>
      </span>
      {action}
    </div>
  );
}

/**
 * While push is not set up on the server, shows a system notification for a
 * new bell item when this tab learns about it (the page refreshes itself
 * about once a minute). With server push, public/sw.js does this instead.
 */
export function useLocalAlerts(items: { id: number; title: string; body: string; lead_id: number | null; read_at: string | null }[], serverPush: boolean) {
  const seen = useRef<number | null>(null);
  const newest = items.reduce((max, item) => Math.max(max, item.id), 0);

  useEffect(() => {
    const before = seen.current;
    seen.current = Math.max(before ?? 0, newest);
    // What was already there when the page opened is not news.
    if (before === null || newest <= before) return;
    const fresh = items.filter((item) => item.id > before && !item.read_at);
    if (serverPush || fresh.length === 0) return;
    if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") return;
    void (async () => {
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        for (const item of fresh.slice(0, 3)) {
          const options = { body: item.body, icon: "/capitup-logo.png", tag: `notification-${item.id}`, data: { url: item.lead_id ? `/leads/${item.lead_id}` : "/my-day" } };
          if (reg) await reg.showNotification(item.title, options);
          else new Notification(item.title, options);
        }
      } catch {
        // The bell still shows it.
      }
    })();
  }, [items, newest, serverPush]);
}
