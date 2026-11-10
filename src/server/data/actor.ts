import "server-only";

import { parseCookies } from "better-auth/cookies";
import { and, eq, gt } from "drizzle-orm";

import { authSession, profiles } from "../db/schema";
import { AccessDeniedError } from "./errors";
import type { DataContext } from "./context";

/** The signed-in, active user every data function acts for: their profile. */
export type Actor = typeof profiles.$inferSelect;

export type ActorResult = { status: "ok"; actor: Actor } | { status: "signed-out" } | { status: "inactive" };

/**
 * Who is making this request. A valid session is not enough: the profile must
 * exist and be active, so deactivating someone cuts them off on their next
 * request even though their session cookie is still valid.
 *
 * Every page and action starts here, so it is kept to one database round
 * trip: the signed session cookie is checked here and the session and profile
 * are read together. Better Auth's own lookup (session, then user, then our
 * profile: three trips in a row) is used only when this cannot answer: no
 * such session, an expired one, or one due for its daily extension.
 */
export async function resolveActor(ctx: DataContext, headers: Headers): Promise<ActorResult> {
  const fast = await resolveFromSessionRow(ctx, headers);
  if (fast) return fast;

  const session = await ctx.auth.api.getSession({ headers });
  if (!session) return { status: "signed-out" };
  const profile = await ctx.db.query.profiles.findFirst({ where: eq(profiles.id, session.user.id) });
  if (!profile || !profile.is_active) return { status: "inactive" };
  return { status: "ok", actor: profile };
}

/** One query for a live session and its profile; null means "ask Better Auth". */
async function resolveFromSessionRow(ctx: DataContext, headers: Headers): Promise<ActorResult | null> {
  const cookie = headers.get("cookie");
  if (!cookie) return { status: "signed-out" };
  const auth = await ctx.auth.$context;
  const signed = parseCookies(cookie).get(auth.authCookies.sessionToken.name);
  if (!signed) return null;
  const token = await verifySignedValue(signed, auth.secret);
  if (!token) return null;

  const now = new Date();
  const [row] = await ctx.db
    .select({ expires_at: authSession.expiresAt, profile: profiles })
    .from(authSession)
    .innerJoin(profiles, eq(profiles.id, authSession.userId))
    .where(and(eq(authSession.token, token), gt(authSession.expiresAt, now)))
    .limit(1);
  if (!row) return null;
  // Better Auth pushes the expiry out once per `updateAge`; leave that write to it.
  const { expiresIn, updateAge } = auth.sessionConfig;
  if (row.expires_at.getTime() - expiresIn * 1000 + updateAge * 1000 <= now.getTime()) return null;
  return row.profile.is_active ? { status: "ok", actor: row.profile } : { status: "inactive" };
}

// One HMAC key per secret for the isolate; importing it on every request costs CPU.
const keys = new Map<string, Promise<CryptoKey>>();

/** The value of a cookie signed the way Better Auth signs it (`value.base64(HMAC-SHA256)`), or null. */
async function verifySignedValue(signed: string, secret: string): Promise<string | null> {
  const dot = signed.lastIndexOf(".");
  if (dot < 1) return null;
  const value = signed.slice(0, dot);
  const signature = signed.slice(dot + 1);
  if (signature.length !== 44 || !signature.endsWith("=")) return null;
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
    keys.set(secret, key);
  }
  try {
    const bytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
    return (await crypto.subtle.verify("HMAC", await key, bytes, new TextEncoder().encode(value))) ? value : null;
  } catch {
    return null;
  }
}

export function isAdmin(actor: Actor): boolean {
  return actor.role === "ADMIN";
}

export function assertAdmin(actor: Actor): void {
  if (!isAdmin(actor)) throw new AccessDeniedError("Only admins can do that.");
}
