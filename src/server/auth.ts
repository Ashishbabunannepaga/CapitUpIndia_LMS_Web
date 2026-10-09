import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "./db/schema";

// Sign-in for the LMS: email + password, sessions stored in D1. There is no
// public sign-up; admins create accounts (src/server/data/users.ts).
//
// Being signed in is not the same as having access: a deactivated user keeps
// a valid session until it is revoked, so always go through getActor()
// (src/server/data/actor.ts), which also checks the profile.

export type AuthEnv = Pick<CloudflareEnv, "BETTER_AUTH_SECRET" | "BETTER_AUTH_URL">;

export function createAuth(d1: D1Database, env: AuthEnv) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be set to a random string of at least 32 characters.");
  }
  return betterAuth({
    appName: "CapitUp LMS",
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(drizzle(d1, { schema }), {
      provider: "sqlite",
      // D1 has no interactive transactions.
      transaction: false,
      schema: {
        user: schema.authUser,
        session: schema.authSession,
        account: schema.authAccount,
        verification: schema.authVerification,
        rateLimit: schema.authRateLimit,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        // Password guessing: 5 tries per minute per IP.
        "/sign-in/email": { window: 60, max: 5 },
      },
    },
    advanced: {
      // UUIDs, like the Supabase ids the rest of the app (and the Firebase
      // import) expects.
      database: { generateId: () => crypto.randomUUID() },
      // Better Auth skips its cross-site checks when NODE_ENV is "test"; keep
      // them on so tests see what production does.
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    telemetry: { enabled: false },
    // Must stay last: writes auth cookies from server actions.
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** The auth instance for the current request's Worker environment. */
export async function getAuth(): Promise<Auth> {
  const { env } = await getCloudflareContext({ async: true });
  return createAuth(env.DB, env);
}
