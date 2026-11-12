import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import { recordAppError } from "@/server/data/monitoring";

// Browser-side failures (src/lib/safe-action.ts and the error pages) are
// written to the Worker log so they show up in Cloudflare Workers Logs, and
// counted for the monitor (Admin > System health), which alerts when many
// pages crash at once. Signed-in users only.

const MAX_BODY = 2_000;

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return new NextResponse(null, { status: 401 });

  const raw = await request.text();
  if (raw.length > MAX_BODY) return new NextResponse(null, { status: 413 });
  let report: Record<string, unknown>;
  try {
    report = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const entry = {
    user: session.actor.id,
    where: text(report.where, 40),
    message: text(report.message, 500),
    digest: text(report.digest, 40),
    path: text(report.path, 200),
    online: report.online === true,
    agent: request.headers.get("user-agent")?.slice(0, 200),
  };
  console.error("[client-error]", entry);
  // An offline browser failing to reach us is the connection, not the app.
  if (entry.online) {
    await recordAppError(session.ctx, {
      source: "browser",
      path: entry.path ?? null,
      message: [entry.where, entry.message, entry.digest && `digest ${entry.digest}`].filter(Boolean).join(": ") || null,
      userId: session.actor.id,
    });
  }
  return new NextResponse(null, { status: 204 });
}
