import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

// GET is used when the server ends a session it should not keep (e.g. the
// account was deactivated); POST is the user's own "Sign out" button.
async function signOut(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();

  const url = new URL("/login", request.url);
  if (request.nextUrl.searchParams.get("reason") === "inactive") {
    url.searchParams.set("error", "inactive");
  }
  return NextResponse.redirect(url, { status: 303 });
}

export const GET = signOut;
export const POST = signOut;
