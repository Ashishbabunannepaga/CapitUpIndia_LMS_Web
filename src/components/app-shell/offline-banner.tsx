"use client";

import { useSyncExternalStore } from "react";
import { WifiOff } from "lucide-react";

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/**
 * A slim bar while the browser reports no network. Saves made offline fail
 * with a message and keep what was typed (see safe-action.ts), so the bar
 * says to wait rather than promising they will go through later.
 */
export function OfflineBanner() {
  const online = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
  if (online) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-40 flex items-center justify-center gap-2 bg-amber-500 px-4 py-1.5 text-center text-sm font-medium text-amber-950 print:hidden"
    >
      <WifiOff className="size-4 shrink-0" />
      You&apos;re offline. Changes won&apos;t save until you reconnect; what you type stays on screen.
    </div>
  );
}
