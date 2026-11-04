import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import { changeStamp } from "@/server/data/changes";

// Polled by RealtimeRefresh (src/components/app-shell/realtime-refresh.tsx).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in again." }, { status: 401, headers: { "cache-control": "no-store" } });
  const stamp = await changeStamp(session.ctx, session.actor);
  return NextResponse.json({ stamp }, { headers: { "cache-control": "no-store" } });
}
