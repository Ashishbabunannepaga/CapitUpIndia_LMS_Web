import { NextResponse, type NextRequest } from "next/server";

import { currentRequestInfo } from "@/lib/auth-cookies";
import { getDataContext } from "@/server/data/context";
import { signOutSession } from "@/server/data/sessions";

// GET is used when the server ends a session it should not keep (e.g. the
// account was deactivated); POST is the user's own "Sign out" button.
async function signOut(request: NextRequest) {
  const url = new URL("/login", request.url);
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

export const GET = signOut;
export const POST = signOut;
