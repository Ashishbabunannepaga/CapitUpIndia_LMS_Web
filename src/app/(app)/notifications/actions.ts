"use server";

import { revalidatePath } from "next/cache";

import { getSession } from "@/lib/auth";
import { markNotificationsRead as markRead } from "@/server/data/notifications";

/** Marks one notification, or all of the user's, as read. Only ever their own. */
export async function markNotificationsRead(id?: number): Promise<void> {
  const session = await getSession();
  if (!session) return;
  await markRead(session.ctx, session.actor, id);
  revalidatePath("/", "layout");
}
