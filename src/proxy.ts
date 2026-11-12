import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

import { publicUrl, workersDevRedirect } from "@/lib/app-url";
import { proxiedClientIp } from "@/lib/client-ip";

// /api/auth is the sign-in API (src/server/auth.ts) and /setup the first-run
// page (src/server/data/setup.ts); both do their own checks. /api/health is
// the uptime check (src/app/api/health/route.ts) and shows no data.
const PUBLIC_PATHS = ["/login", "/auth", "/api/auth", "/setup", "/api/health"];

/**
 * Sends visitors without a session cookie to /login. This is a convenience
 * redirect only: every page, action and route still resolves the user on the
 * server (src/lib/auth.ts), and the data layer enforces access.
 */
export async function proxy(request: NextRequest) {
  const moved = workersDevRedirect(request.method, request.url, request.headers);
  if (moved) return NextResponse.redirect(moved, 308);

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (isPublic || getSessionCookie(request)) {
    // Through CloudFront, hand the visitor's own IP to the sign-in rate limit.
    const ip = proxiedClientIp(request.headers, process.env.ORIGIN_VERIFY_SECRET);
    if (!ip) return NextResponse.next();
    const headers = new Headers(request.headers);
    headers.set("cf-connecting-ip", ip);
    return NextResponse.next({ request: { headers } });
  }

  const back = `${pathname}${request.nextUrl.search}`;
  const url = publicUrl(pathname === "/" ? "/login" : `/login?next=${encodeURIComponent(back)}`, request.url);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    // Everything except Next.js internals and static files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
