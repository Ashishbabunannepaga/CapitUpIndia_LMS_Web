import "server-only";

import { and, count, desc, eq, gte, lt } from "drizzle-orm";

import { notifications, profiles, signInFailures } from "../db/schema";
import { assertAdmin, type Actor } from "./actor";
import type { DataContext } from "./context";

// Failed sign-ins: a record for admins and an alert when someone keeps
// guessing. Every failure is also written to the Worker log (Workers Logs in
// the Cloudflare dashboard) as one JSON line with event "sign_in_failed".
//
// Alerts go to every active admin's in-app bell, once per burst:
//   * an email reaches ALERT_PER_EMAIL failures within WINDOW_MINUTES
//     (someone guessing one person's password), or
//   * one IP reaches ALERT_PER_IP failures within WINDOW_MINUTES
//     (someone trying many accounts).
// The sign-in rate limit (5 tries a minute per IP, src/server/auth.ts) still
// does the blocking; this is about telling a person.

export const WINDOW_MINUTES = 15;
export const ALERT_PER_EMAIL = 5;
export const ALERT_PER_IP = 10;
/** Rows older than this are deleted as new failures come in. */
export const KEEP_DAYS = 90;

export type SignInFailureReason = "invalid" | "inactive" | "rate-limited";

export type FailureInfo = {
  email: string;
  ip: string | null;
  userAgent: string | null;
  reason: SignInFailureReason;
};

function minutesAgo(at: Date, minutes: number): string {
  return new Date(at.getTime() - minutes * 60_000).toISOString();
}

/**
 * Records a failed sign-in and alerts admins when a threshold is crossed.
 * Never throws: a logging problem must not change what the person signing in
 * sees.
 */
export async function recordSignInFailure(ctx: DataContext, info: FailureInfo, at: Date = new Date()): Promise<void> {
  const email = info.email.trim().toLowerCase().slice(0, 320);
  const ip = info.ip?.slice(0, 64) || null;
  console.warn(JSON.stringify({ event: "sign_in_failed", reason: info.reason, email, ip }));

  // Blocked attempts are already capped by the rate limit and cost no
  // password check; storing each one would let a flood fill D1.
  if (info.reason === "rate-limited") return;

  try {
    const since = minutesAgo(at, WINDOW_MINUTES);
    const [, , byEmail, byIp] = await ctx.db.batch([
      ctx.db.insert(signInFailures).values({
        email,
        ip,
        user_agent: info.userAgent?.slice(0, 300) || null,
        reason: info.reason,
        created_at: at.toISOString(),
      }),
      ctx.db.delete(signInFailures).where(lt(signInFailures.created_at, minutesAgo(at, KEEP_DAYS * 24 * 60))),
      ctx.db
        .select({ total: count() })
        .from(signInFailures)
        .where(and(eq(signInFailures.email, email), gte(signInFailures.created_at, since))),
      ctx.db
        .select({ total: count() })
        .from(signInFailures)
        .where(and(ip ? eq(signInFailures.ip, ip) : eq(signInFailures.id, -1), gte(signInFailures.created_at, since))),
    ]);

    // "Reaches" (===), so a burst raises one alert, not one per attempt.
    const emailHits = byEmail[0]?.total ?? 0;
    const ipHits = byIp[0]?.total ?? 0;
    const alerts: { title: string; body: string }[] = [];
    if (emailHits === ALERT_PER_EMAIL) {
      alerts.push({
        title: `${ALERT_PER_EMAIL} failed sign-ins for ${email}`,
        body: `${ALERT_PER_EMAIL} wrong passwords for this account in ${WINDOW_MINUTES} minutes${ip ? `, the latest from ${ip}` : ""}. If it wasn't them, reset their password on Team.`,
      });
    }
    if (ip && ipHits === ALERT_PER_IP) {
      alerts.push({
        title: `${ALERT_PER_IP} failed sign-ins from ${ip}`,
        body: `One address failed to sign in ${ALERT_PER_IP} times in ${WINDOW_MINUTES} minutes, the latest as ${email}. See Team > Failed sign-ins.`,
      });
    }
    if (alerts.length) await alertAdmins(ctx, alerts);
  } catch (error) {
    console.error("Could not record a failed sign-in.", error);
  }
}

async function alertAdmins(ctx: DataContext, alerts: { title: string; body: string }[]): Promise<void> {
  const admins = await ctx.db
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.role, "ADMIN"), eq(profiles.is_active, true)));
  const rows = admins.flatMap(({ id }) =>
    alerts.map((a) => ({ user_id: id, kind: "other" as const, title: a.title.slice(0, 300), body: a.body.slice(0, 2000) })),
  );
  // D1 caps bound parameters per statement, so insert a few rows at a time.
  for (let i = 0; i < rows.length; i += 10) await ctx.db.insert(notifications).values(rows.slice(i, i + 10));
}

export type SignInFailureRow = typeof signInFailures.$inferSelect;

/** The most recent failed sign-ins. Admins only. */
export async function recentSignInFailures(ctx: DataContext, actor: Actor, limit = 50): Promise<SignInFailureRow[]> {
  assertAdmin(actor);
  return ctx.db.select().from(signInFailures).orderBy(desc(signInFailures.created_at), desc(signInFailures.id)).limit(limit);
}
