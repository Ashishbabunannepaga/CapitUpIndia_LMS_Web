import "server-only";

import { eq } from "drizzle-orm";

import { profiles } from "../db/schema";
import type { DataContext } from "./context";

// Signing in and out for the login form and the sign-out route. Both go
// through Better Auth's HTTP handler (not auth.api), so the sign-in rate
// limit and the origin check apply exactly as they do for any browser.

export type SignInResult =
  | { status: "ok"; setCookies: string[] }
  | { status: "invalid" }
  | { status: "rate-limited" }
  | { status: "inactive" };

export type RequestInfo = {
  /** The app's origin, e.g. https://lms.example.com. */
  origin: string;
  /** The caller's IP (cf-connecting-ip), which the rate limit counts by. */
  ip: string | null;
  userAgent?: string | null;
};

function authRequest(path: string, info: RequestInfo, init: { body?: unknown; cookie?: string }) {
  const headers = new Headers({ "content-type": "application/json", origin: info.origin });
  if (info.ip) headers.set("cf-connecting-ip", info.ip);
  if (info.userAgent) headers.set("user-agent", info.userAgent);
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(new URL(`/api/auth${path}`, info.origin), {
    method: "POST",
    headers,
    body: JSON.stringify(init.body ?? {}),
  });
}

/**
 * Checks the password and starts a session. A deactivated account gets
 * "inactive" and no session, even with the right password.
 */
export async function signInWithPassword(
  ctx: DataContext,
  credentials: { email: string; password: string },
  info: RequestInfo,
): Promise<SignInResult> {
  const response = await ctx.auth.handler(
    authRequest("/sign-in/email", info, { body: { ...credentials, rememberMe: true } }),
  );
  if (response.status === 429) return { status: "rate-limited" };
  if (!response.ok) return { status: "invalid" };

  const body = (await response.json()) as { token?: string; user?: { id?: string } };
  const profile = body.user?.id
    ? await ctx.db.query.profiles.findFirst({ where: eq(profiles.id, body.user.id) })
    : undefined;
  if (!profile?.is_active) {
    if (body.token) {
      const auth = await ctx.auth.$context;
      await auth.internalAdapter.deleteSession(body.token);
    }
    return { status: "inactive" };
  }
  return { status: "ok", setCookies: response.headers.getSetCookie() };
}

/** Ends the session in these cookies. Returns the Set-Cookie headers that clear them. */
export async function signOutSession(ctx: DataContext, cookie: string, info: RequestInfo): Promise<string[]> {
  const response = await ctx.auth.handler(authRequest("/sign-out", info, { cookie }));
  return response.headers.getSetCookie();
}
