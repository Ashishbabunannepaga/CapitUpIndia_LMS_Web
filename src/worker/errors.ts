import { databaseFor } from "@/server/data/context";
import { recordAppError } from "@/server/data/monitoring";

/** Paths whose failures are already counted elsewhere. */
const SKIP = new Set(["/api/health"]);

/**
 * Records a request the Worker answered with a 5xx, or that threw, so the
 * monitor can alert on it (worker.ts runs this after the response is sent).
 */
export async function recordFailedRequest(env: Pick<CloudflareEnv, "DB">, request: Request, status: number, error?: unknown): Promise<void> {
  const { pathname } = new URL(request.url);
  if (SKIP.has(pathname)) return;
  const message = error === undefined ? null : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  await recordAppError({ db: databaseFor(env.DB) }, { source: "server", path: `${request.method} ${pathname}`, status, message });
}
