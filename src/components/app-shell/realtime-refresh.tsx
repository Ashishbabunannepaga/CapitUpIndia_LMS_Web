"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

const INTERVAL_MS = 60_000;
/** Re-render anyway after this long, in case two changes landed in the same second. */
const MAX_STALE_MS = 10 * 60_000;

/**
 * Keeps the page current while the tab is visible: every minute (and on
 * coming back to the tab) it asks /api/changes whether anything changed, and
 * re-renders the page only when it did. Re-rendering every minute regardless
 * cost a full page of Worker CPU and D1 reads per open tab per minute.
 * `stamp` is the change stamp the page was drawn with. router.refresh() keeps
 * what the user is typing. A page that is watched live (the admins' leads
 * tracker) can ask more often with `intervalMs`: the check reads one row.
 */
export function RealtimeRefresh({ stamp, intervalMs = INTERVAL_MS }: { stamp: number; intervalMs?: number }) {
  const router = useRouter();
  const seen = useRef(stamp);
  const drawnAt = useRef(0);

  // A new render (refresh, navigation or the user's own action) brings a new stamp.
  useEffect(() => {
    seen.current = stamp;
    drawnAt.current = Date.now();
  }, [stamp]);

  useEffect(() => {
    let last = Date.now();
    let busy = false;
    const check = async () => {
      if (document.visibilityState !== "visible" || busy) return;
      busy = true;
      last = Date.now();
      try {
        const response = await fetch("/api/changes", { cache: "no-store" });
        if (response.status === 401 || response.redirected) {
          router.refresh(); // Signed out or disabled: the page sends them to sign in.
          return;
        }
        if (!response.ok) return;
        const { stamp: latest } = (await response.json()) as { stamp: number };
        if (latest !== seen.current || Date.now() - drawnAt.current > MAX_STALE_MS) {
          seen.current = latest;
          drawnAt.current = Date.now();
          router.refresh();
        }
      } catch {
        // Offline for a moment; try again next time.
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(check, intervalMs);
    const onVisible = () => {
      if (Date.now() - last > intervalMs / 2) void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, intervalMs]);

  return null;
}
