import { NextResponse, type NextRequest } from "next/server";

import { publicUrl } from "@/lib/app-url";
import { currentRequestInfo } from "@/lib/auth-cookies";
import { resolveActor } from "@/server/data/actor";
import { getDataContext } from "@/server/data/context";
import { signOutSession } from "@/server/data/sessions";

// GET is used when the server ends a session it should not keep (the account
// was deactivated); POST is the user's own "Sign out" button. Another site
// can make a browser send a GET, so GET only signs out an account that is
// really inactive; an active user is sent back to the app.
export async function GET(request: NextRequest) {
  const ctx = await getDataContext();
  const result = await resolveActor(ctx, request.headers);
  if (result.status === "ok") return NextResponse.redirect(publicUrl("/my-day", request.url), { status: 303 });
  return signOut(request);
}

export async function POST(request: NextRequest) {
  return signOut(request);
}

async function signOut(request: NextRequest) {
  const url = publicUrl("/login", request.url);
  if (request.nextUrl.searchParams.get("reason") === "inactive") {
    url.searchParams.set("error", "inactive");
  }
  const response = NextResponse.redirect(url, { status: 303 });

  const cookie = request.headers.get("cookie");
  if (cookie) {
    const ctx = await getDataContext();
    for (const header of await signOutSession(ctx, cookie, await currentRequestInfo())) {
      response.headers.append("set-cookie", header);
    }
  }
  return response;
}
