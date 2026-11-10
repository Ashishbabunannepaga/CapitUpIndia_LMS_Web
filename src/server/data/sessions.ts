import "server-only";

import { and, eq } from "drizzle-orm";

import { authAccount, profiles } from "../db/schema";
import { isLegacyPasswordHash } from "../password";
import type { DataContext } from "./context";
import { recordSignInFailure } from "./sign-in-failures";

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
  const failure = { email: credentials.email, ip: info.ip, userAgent: info.userAgent ?? null };
  if (response.status === 429) {
    await recordSignInFailure(ctx, { ...failure, reason: "rate-limited" });
    return { status: "rate-limited" };
  }
  if (!response.ok) {
    await recordSignInFailure(ctx, { ...failure, reason: "invalid" });
    return { status: "invalid" };
  }

  const body = (await response.json()) as { token?: string; user?: { id?: string } };
  const profile = body.user?.id
    ? await ctx.db.query.profiles.findFirst({ where: eq(profiles.id, body.user.id) })
    : undefined;
  if (!profile?.is_active) {
    if (body.token) {
      const auth = await ctx.auth.$context;
      await auth.internalAdapter.deleteSession(body.token);
    }
    await recordSignInFailure(ctx, { ...failure, reason: "inactive" });
    return { status: "inactive" };
  }
  await upgradeLegacyPassword(ctx, profile.id, credentials.password);
  return { status: "ok", setCookies: response.headers.getSetCookie() };
}

/**
 * Re-hashes an older scrypt password with the current scheme after a correct
 * sign-in, so later sign-ins skip scrypt's 32 MB. Never blocks the sign-in.
 */
async function upgradeLegacyPassword(ctx: DataContext, userId: string, password: string): Promise<void> {
  try {
    const where = and(eq(authAccount.userId, userId), eq(authAccount.providerId, "credential"));
    const account = await ctx.db.query.authAccount.findFirst({ where });
    if (!account?.password || !isLegacyPasswordHash(account.password)) return;
    const auth = await ctx.auth.$context;
    await ctx.db
      .update(authAccount)
      .set({ password: await auth.password.hash(password), updatedAt: new Date() })
      .where(where);
  } catch (error) {
    console.error("Password upgrade failed; sign-in continues.", error);
  }
}

/** Ends the session in these cookies. Returns the Set-Cookie headers that clear them. */
export async function signOutSession(ctx: DataContext, cookie: string, info: RequestInfo): Promise<string[]> {
  const response = await ctx.auth.handler(authRequest("/sign-out", info, { cookie }));
  return response.headers.getSetCookie();
}

/**
 * Runs a request to the public Better Auth endpoint (/api/auth/*) and records
 * failed email sign-ins made there directly, so a script that skips the login
 * form is still logged and alerted on.
 */
export async function handleAuthRequest(ctx: DataContext, request: Request): Promise<Response> {
  const isSignIn = request.method === "POST" && new URL(request.url).pathname.endsWith("/sign-in/email");
  if (!isSignIn) return ctx.auth.handler(request);

  let email = "";
  try {
    const body = (await request.clone().json()) as { email?: unknown };
    if (typeof body.email === "string") email = body.email;
  } catch {
    // Not JSON; Better Auth will reject it.
  }
  const response = await ctx.auth.handler(request);
  if ((response.status === 429 || response.status === 401) && email) {
    await recordSignInFailure(ctx, {
      email,
      ip: request.headers.get("cf-connecting-ip"),
      userAgent: request.headers.get("user-agent"),
      reason: response.status === 429 ? "rate-limited" : "invalid",
    });
  }
  return response;
}
