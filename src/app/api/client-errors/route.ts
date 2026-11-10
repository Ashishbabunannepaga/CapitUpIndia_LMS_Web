import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";

// Browser-side failures (src/lib/safe-action.ts and the error pages) are
// written to the Worker log so they show up in Cloudflare Workers Logs.
// Signed-in users only; nothing is stored and nothing is read back.

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

  console.error("[client-error]", {
    user: session.actor.id,
    where: text(report.where, 40),
    message: text(report.message, 500),
    digest: text(report.digest, 40),
    path: text(report.path, 200),
    online: report.online === true,
    agent: request.headers.get("user-agent")?.slice(0, 200),
  });
  return new NextResponse(null, { status: 204 });
}
