import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";

import { databaseFor } from "@/server/data/context";
import { checkDatabase } from "@/server/data/monitoring";

// Public, for uptime checkers (the cron's own check and UptimeRobot): is the
// Worker up and can it reach D1? Says nothing else about the app.
export const dynamic = "force-dynamic";

export async function GET() {
  const { env } = await getCloudflareContext({ async: true });
  const db = await checkDatabase({ db: databaseFor(env.DB) });
  return NextResponse.json(
    {
      status: db.ok ? "ok" : "error",
      db: db.ok ? "ok" : "error",
      timestamp: new Date().toISOString(),
      version: env.CF_VERSION_METADATA?.id ?? "unknown",
    },
    { status: db.ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
