import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

// /api/auth is the sign-in API (src/server/auth.ts) and /setup the first-run
// page (src/server/data/setup.ts); both do their own checks.
const PUBLIC_PATHS = ["/login", "/auth", "/api/auth", "/setup"];

/**
 * Sends visitors without a session cookie to /login. This is a convenience
 * redirect only: every page, action and route still resolves the user on the
 * server (src/lib/auth.ts), and the data layer enforces access.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (isPublic || getSessionCookie(request)) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  const back = `${pathname}${request.nextUrl.search}`;
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(back)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    // Everything except Next.js internals and static files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
