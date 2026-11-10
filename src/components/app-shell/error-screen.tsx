"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { isStaleBuildError, reportClientError } from "@/lib/safe-action";

// One automatic reload per tab per minute, so a page that keeps failing
// shows this screen instead of reloading forever.
const RELOAD_KEY = "lms:auto-reload-at";

function reloadedRecently(): boolean {
  try {
    const at = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    return Date.now() - at < 60_000;
  } catch {
    return true;
  }
}

function markReload() {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Private mode without storage: reloadedRecently() already says true.
  }
}

/**
 * Shown when part of the app fails to render (src/app/error.tsx,
 * src/app/(app)/error.tsx, src/app/global-error.tsx). A tab running code from
 * before the latest deploy reloads itself once; anything else is reported to
 * the server log and offered "Try again".
 */
export function ErrorScreen({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  const router = useRouter();
  // Decided once, on the client, when the screen first appears.
  const [reloading] = useState(
    () =>
      typeof window !== "undefined" &&
      isStaleBuildError(error) &&
      !reloadedRecently(),
  );
  const digest =
    error && typeof error === "object" && "digest" in error && error.digest
      ? String(error.digest)
      : null;

  useEffect(() => {
    if (reloading) {
      markReload();
      window.location.reload();
      return;
    }
    reportClientError(error, "page");
  }, [error, reloading]);

  if (reloading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center p-6 text-sm text-muted-foreground">
        <RotateCw className="mr-2 size-4 animate-spin" />
        Loading the latest version…
      </div>
    );
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div
        role="alert"
        className="w-full max-w-md rounded-2xl border bg-card p-6 text-card-foreground shadow-card"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
          <div className="space-y-1">
            <h1 className="text-base font-semibold">This page didn’t load</h1>
            <p className="text-sm text-muted-foreground">
              Nothing you saved earlier is lost. Try again, and if it keeps
              happening, reload the page or check your connection.
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => retry()}>
            <RotateCw />
            Try again
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => window.location.reload()}
          >
            Reload page
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              window.history.length > 1 ? router.back() : router.push("/")
            }
          >
            Go back
          </Button>
        </div>
        {digest ? (
          <p className="mt-4 font-mono text-xs text-muted-foreground">
            Error reference {digest}
          </p>
        ) : null}
      </div>
    </div>
  );
}
