"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { friendlyError } from "@/lib/action-errors";
import { getSession } from "@/lib/auth";
import { markNotificationsRead as markRead } from "@/server/data/notifications";
import {
  removePushSubscription as removePush,
  savePushSubscription as savePush,
  type PushSubscriptionInput,
} from "@/server/data/push";

/** Marks one notification, or all of the user's, as read. Only ever their own. */
export async function markNotificationsRead(id?: number): Promise<void> {
  const session = await getSession();
  if (!session) return;
  await markRead(session.ctx, session.actor, id);
  revalidatePath("/", "layout");
}

export type PushActionResult = { ok: true } | { ok: false; error: string };

/** Saves this browser's push subscription for the signed-in user. */
export async function savePushSubscription(subscription: PushSubscriptionInput): Promise<PushActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Your session has ended. Sign in again." };
  try {
    const userAgent = (await headers()).get("user-agent") ?? "";
    await savePush(session.ctx, session.actor, subscription, userAgent);
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
  return { ok: true };
}

/** Turns push off for this browser. */
export async function removePushSubscription(endpoint: string): Promise<void> {
  const session = await getSession();
  if (!session) return;
  await removePush(session.ctx, session.actor, endpoint);
}
