import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import type { Database } from "@/lib/database.types";
import { publicEnv } from "@/lib/env";

// /api/auth is the D1 sign-in API (src/server/auth.ts). /api/inngest is
// called by Inngest, not a browser; it verifies its own signature with
// INNGEST_SIGNING_KEY.
const PUBLIC_PATHS = ["/login", "/auth", "/api/auth", "/api/inngest"];

/**
 * Refreshes the Supabase session cookie on every request and sends signed-out
 * visitors to /login. This is a convenience redirect only: every page, action
 * and query still checks the user on the server, and RLS enforces access.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const env = publicEnv();

  const supabase = createServerClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
      },
    },
  });

  // Do not run code between createServerClient and getClaims(): it validates
  // the JWT and refreshes an expired session.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!signedIn && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    const back = `${pathname}${request.nextUrl.search}`;
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(back)}`;
    return NextResponse.redirect(url);
  }

  return response;
}
