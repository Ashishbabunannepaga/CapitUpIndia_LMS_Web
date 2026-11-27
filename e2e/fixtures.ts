import { readFileSync } from "node:fs";

import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import type { Page } from "@playwright/test";
import { getPlatformProxy } from "wrangler";

import { createDataContext, type DataContext } from "@/server/data/context";

// Shared accounts and database access for the end-to-end tests. The app runs
// as the built Worker under `wrangler dev` with a local D1 and R2
// (.wrangler/state); the tests open the same local database to set up data
// and check what landed. Nothing here touches a real Cloudflare account.

export const PORT = Number(process.env.E2E_PORT ?? 3100);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const AUTH_SECRET = "e2e-only-secret-0123456789abcdef0123456789";

export const PASSWORD = "e2e-Password-1!";

export const USERS = {
  admin: { email: "admin@e2e.test", name: "Esha Admin", role: "ADMIN" as const },
  amit: { email: "amit@e2e.test", name: "Amit E2E", role: "AGENT" as const },
  neha: { email: "neha@e2e.test", name: "Neha E2E", role: "AGENT" as const },
};
export type UserKey = keyof typeof USERS;

export type LocalDb = { d1: D1Database; ctx: DataContext; dispose: () => Promise<void> };

/** The local D1 and R2 the running app uses. Dispose when done. */
export async function openLocalDb(): Promise<LocalDb> {
  const proxy = await getPlatformProxy<CloudflareEnv>({ persist: true });
  const ctx = createDataContext(proxy.env.DB, { BETTER_AUTH_SECRET: AUTH_SECRET, BETTER_AUTH_URL: BASE_URL }, proxy.env.CARDS);
  return { d1: proxy.env.DB, ctx, dispose: () => proxy.dispose() };
}

export async function userId(db: LocalDb, user: UserKey): Promise<string> {
  const row = await queryFirst<{ id: string }>(db, "select id from profiles where email = ?", USERS[user].email);
  if (!row) throw new Error(`No profile for ${USERS[user].email}; global setup did not run`);
  return row.id;
}

/** The profile row as the data layer's Actor, to act as a user in setup code. */
export async function actor(db: LocalDb, user: UserKey) {
  const id = await userId(db, user);
  const profile = await retrying(() => db.ctx.db.query.profiles.findFirst({ where: (p, { eq }) => eq(p.id, id) }));
  if (!profile) throw new Error(`No profile for ${USERS[user].email}`);
  return profile;
}

/**
 * A made-up client address for one sign-in. Sign-in is rate limited per
 * address, and every test signs in, so each sign-in gets its own. Random,
 * because each spec file loads this module afresh.
 */
export function clientAddress(): string {
  const [a, b, c] = crypto.getRandomValues(new Uint8Array(3));
  return `10.${a}.${b}.${c}`;
}

/**
 * Runs a database step from the test side, retrying while the running app
 * holds the SQLite lock: the tests and the Worker are two processes sharing
 * one local database file, which production never does.
 */
export async function retrying<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      const text = `${error} ${(error as { cause?: unknown })?.cause ?? ""}`;
      if (attempt >= 20 || !/SQLITE_BUSY|database is locked|commit token/.test(text)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** One row from the local database, or null. */
export function queryFirst<T = Record<string, unknown>>(db: LocalDb, sql: string, ...binds: unknown[]): Promise<T | null> {
  return retrying(() => db.d1.prepare(sql).bind(...binds).first<T>());
}

export function execute(db: LocalDb, sql: string, ...binds: unknown[]) {
  return retrying(() => db.d1.prepare(sql).bind(...binds).run());
}

// Admins must use two-step sign-in (audit R11). Global setup switches it on
// for the e2e admin and keeps the authenticator secret here.
export const ADMIN_TOTP_FILE = ".wrangler/e2e-admin-totp";

/** The base32 key from an otpauth:// link, as the raw secret the code is made from. */
export function totpSecretFromUri(uri: string): string {
  return new TextDecoder().decode(base32.decode(new URL(uri).searchParams.get("secret")!));
}

/** The current authenticator code for the e2e admin. */
export function adminTotpCode(): Promise<string> {
  return createOTP(readFileSync(ADMIN_TOTP_FILE, "utf8").trim()).totp();
}

/** After the password step: enters the admin's code when the app asks for one. */
export async function passTwoFactor(page: Page): Promise<void> {
  // The sign-in form posts and then navigates: wait until it has left /login.
  await page.waitForURL((url) => url.pathname !== "/login");
  if (!new URL(page.url()).pathname.startsWith("/login/two-factor")) return;
  await page.getByLabel("6-digit code").fill(await adminTotpCode());
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}
