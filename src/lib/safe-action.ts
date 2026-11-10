// Calling server actions from the browser without crashing the page.
//
// A server action can fail before our own code runs: the phone drops off the
// network, the Worker hits a platform limit, CloudFront times out, or the
// page was loaded before the latest deploy and its action ids no longer
// exist. React then throws inside the transition, and with nothing to catch
// it the whole screen became Next.js's "This page couldn't load". These
// helpers turn those failures into an ordinary { ok: false, error } result,
// so the form keeps what was typed and shows a line of text instead.

import { unstable_rethrow } from "next/navigation";

export type ActionFailure = { ok: false; error: string };

// Signs that this tab is running an older build than the server.
const STALE_BUILD = [
  /server action .*not found/i,
  /failed to find server action/i,
  /unrecognizedactionerror/i,
  /chunkloaderror/i,
  /loading (css )?chunk [\w-]+ failed/i,
  /dynamically imported module/i,
  /importing a module script failed/i,
];

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** True when the error means this tab's code is older than the deployed app. */
export function isStaleBuildError(error: unknown): boolean {
  const text = describe(error);
  return STALE_BUILD.some((pattern) => pattern.test(text));
}

/** The sentence shown when an action could not reach the server. */
export function actionFailureMessage(error: unknown): string {
  if (isStaleBuildError(error))
    return "The app was just updated. Reload the page, then try again.";
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "You are offline, so nothing was saved. Try again when you are back online.";
  }
  return "The server did not answer, so nothing was saved. Try again in a moment.";
}

/**
 * Runs a server action and returns its result, or { ok: false, error } when
 * the call itself failed. Next.js redirects and notFound() still go through.
 */
export async function safeAction<T>(
  run: () => Promise<T>,
): Promise<T | ActionFailure> {
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    reportClientError(error, "action");
    return { ok: false, error: actionFailureMessage(error) };
  }
}

/**
 * Sends a short description of a browser-side failure to the server log
 * (Cloudflare Workers Logs, filter on "client-error"). Best effort only.
 */
export function reportClientError(error: unknown, where: string): void {
  if (typeof window === "undefined") return;
  try {
    const digest =
      error && typeof error === "object" && "digest" in error
        ? String(error.digest)
        : undefined;
    const body = JSON.stringify({
      where,
      message: describe(error).slice(0, 500),
      digest,
      path: window.location.pathname,
      online: navigator.onLine,
    });
    void fetch("/api/client-errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Reporting must never cause a second error.
  }
}
