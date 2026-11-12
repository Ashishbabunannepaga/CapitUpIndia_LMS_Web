import "server-only";

import { and, asc, eq, gte, inArray, isNull, lt } from "drizzle-orm";

import { notifications, pushSubscriptions } from "../db/schema";
import type { Actor } from "./actor";
import type { DataContext } from "./context";
import { InvalidInputError } from "./errors";
import type { PushResult, PushTarget } from "../push/web-push";

// Browser push notifications. Each person's browsers subscribe (with their
// permission); the per-minute cron pushes every new bell notification to the
// browsers of the person it is for. People can only add or remove their own
// subscriptions; nobody can read anyone else's.

export type PushSubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string } };

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function checkSubscription(input: PushSubscriptionInput): PushSubscriptionInput {
  const endpoint = String(input?.endpoint ?? "");
  const p256dh = String(input?.keys?.p256dh ?? "");
  const auth = String(input?.keys?.auth ?? "");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new InvalidInputError("That browser subscription is not valid.");
  }
  if (url.protocol !== "https:" || endpoint.length > 1000) throw new InvalidInputError("That browser subscription is not valid.");
  if (!BASE64URL.test(p256dh) || p256dh.length > 200 || !BASE64URL.test(auth) || auth.length > 100) {
    throw new InvalidInputError("That browser subscription is not valid.");
  }
  return { endpoint, keys: { p256dh, auth } };
}

/**
 * Saves this browser's push subscription for the caller. A browser that was
 * signed in as someone else moves to the caller, so one device never gets
 * two people's alerts.
 */
export async function savePushSubscription(
  ctx: DataContext,
  actor: Actor,
  input: PushSubscriptionInput,
  userAgent = "",
): Promise<void> {
  const { endpoint, keys } = checkSubscription(input);
  await ctx.db
    .insert(pushSubscriptions)
    .values({ user_id: actor.id, endpoint, p256dh: keys.p256dh, auth: keys.auth, user_agent: userAgent.slice(0, 300) })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { user_id: actor.id, p256dh: keys.p256dh, auth: keys.auth, user_agent: userAgent.slice(0, 300) },
    });
}

/** Forgets one of the caller's browsers (they turned push off). */
export async function removePushSubscription(ctx: DataContext, actor: Actor, endpoint: string): Promise<void> {
  await ctx.db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.user_id, actor.id), eq(pushSubscriptions.endpoint, String(endpoint ?? ""))));
}

/** How many browsers the caller gets push notifications on. */
export async function countPushSubscriptions(ctx: DataContext, actor: Actor): Promise<number> {
  const rows = await ctx.db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.user_id, actor.id));
  return rows.length;
}

/** Sends one message to one browser; the cron passes sendWebPush with the VAPID keys. */
export type PushSender = (target: PushTarget, message: PushMessage) => Promise<PushResult>;

/** What the service worker (public/sw.js) shows. */
export type PushMessage = { title: string; body: string; url: string; tag: string };

/** Notifications pushed per cron run, so a backlog cannot blow the Worker's limits. */
export const PUSH_BATCH = 50;
/** Older notifications are not worth a buzz any more; they stay in the bell. */
const PUSH_WINDOW_MS = 60 * 60_000;

/**
 * Pushes bell notifications that have not been pushed yet to their owners'
 * browsers, then marks them pushed (also when the person has no browser
 * subscribed). Subscriptions the push service says are gone are deleted.
 * Returns how many messages went out.
 */
export async function pushPendingNotifications(ctx: DataContext, send: PushSender, at: Date = new Date()): Promise<number> {
  const since = new Date(at.getTime() - PUSH_WINDOW_MS).toISOString();
  const stamp = at.toISOString();

  // Too old to push: mark them so they are not looked at again.
  await ctx.db
    .update(notifications)
    .set({ pushed_at: stamp })
    .where(and(isNull(notifications.pushed_at), lt(notifications.created_at, since)));

  const pending = await ctx.db
    .select({
      id: notifications.id,
      user_id: notifications.user_id,
      title: notifications.title,
      body: notifications.body,
      lead_id: notifications.lead_id,
    })
    .from(notifications)
    .where(and(isNull(notifications.pushed_at), gte(notifications.created_at, since)))
    .orderBy(asc(notifications.created_at), asc(notifications.id))
    .limit(PUSH_BATCH);
  if (pending.length === 0) return 0;

  const userIds = [...new Set(pending.map((n) => n.user_id))];
  const subs = await ctx.db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.user_id, userIds));
  const byUser = new Map<string, typeof subs>();
  for (const sub of subs) byUser.set(sub.user_id, [...(byUser.get(sub.user_id) ?? []), sub]);

  // Claim them first, so an overlapping cron run cannot push the same ones again.
  await ctx.db
    .update(notifications)
    .set({ pushed_at: stamp })
    .where(and(inArray(notifications.id, pending.map((n) => n.id)), isNull(notifications.pushed_at)));

  const gone = new Set<number>();
  const delivered = new Set<number>();
  let sent = 0;
  await Promise.all(
    pending.flatMap((n) =>
      (byUser.get(n.user_id) ?? []).map(async (sub) => {
        if (gone.has(sub.id)) return;
        try {
          const result = await send(
            { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
            { title: n.title, body: n.body, url: n.lead_id ? `/leads/${n.lead_id}` : "/my-day", tag: `notification-${n.id}` },
          );
          if (result.gone) gone.add(sub.id);
          else if (result.ok) {
            delivered.add(sub.id);
            sent++;
          } else console.warn("Push refused", { status: result.status, host: new URL(sub.endpoint).host });
        } catch (error) {
          console.warn("Push failed", { message: error instanceof Error ? error.message : String(error) });
        }
      }),
    ),
  );

  if (gone.size > 0) await ctx.db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, [...gone]));
  if (delivered.size > 0) {
    await ctx.db.update(pushSubscriptions).set({ last_sent_at: stamp }).where(inArray(pushSubscriptions.id, [...delivered]));
  }
  return sent;
}
