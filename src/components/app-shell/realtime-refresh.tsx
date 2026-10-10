"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const INTERVAL_MS = 60_000;

/**
 * Re-renders the current page every minute while the tab is visible, and when
 * the user comes back to it, so assignments, status changes, new notes and
 * reminders from teammates show up without a reload. router.refresh() keeps
 * what the user is typing.
 */
export function RealtimeRefresh() {
  const router = useRouter();

  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      last = Date.now();
      router.refresh();
    };
    const timer = setInterval(refresh, INTERVAL_MS);
    // Coming back to the tab after a while: refresh straight away.
    const onVisible = () => {
      if (Date.now() - last > INTERVAL_MS / 2) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  return null;
}
