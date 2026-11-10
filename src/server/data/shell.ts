import "server-only";

import { eq } from "drizzle-orm";

import { changeVersion } from "../db/schema";
import type { Actor } from "./actor";
import type { DataContext } from "./context";
import { countUnreadLeadNotesQuery } from "./leads";
import { recentNotificationsQueries, type Notification } from "./notifications";

export type ShellSummary = {
  /** The change stamp the page is drawn with (see changes.ts). */
  stamp: number;
  unreadNotes: number;
  notifications: Notification[];
  unreadNotifications: number;
};

/**
 * What the app frame around every page shows: the change stamp, the unread
 * note badge and the reminder bell. One D1 round trip: a batch runs its
 * statements in order, so the stamp is still read before the rest and a
 * change made while the page renders counts as new on the next poll.
 */
export async function shellSummary(ctx: DataContext, actor: Actor): Promise<ShellSummary> {
  const [notificationItems, notificationUnread] = recentNotificationsQueries(ctx, actor, 20);
  const [stampRows, noteRows, items, unreadRows] = await ctx.db.batch([
    ctx.db.select({ version: changeVersion.version }).from(changeVersion).where(eq(changeVersion.id, 1)),
    countUnreadLeadNotesQuery(ctx, actor),
    notificationItems,
    notificationUnread,
  ]);
  return {
    stamp: stampRows[0]?.version ?? 0,
    unreadNotes: noteRows[0]?.n ?? 0,
    notifications: items,
    unreadNotifications: unreadRows[0]?.n ?? 0,
  };
}
