import "server-only";

import { eq } from "drizzle-orm";

import { changeVersion } from "../db/schema";
import type { Actor } from "./actor";
import type { DataContext } from "./context";

// "Has anything changed since this page was drawn?" Open tabs ask this every
// minute instead of re-rendering the page, which made each poll cost as much
// CPU and D1 reads as a full page load. The answer is one number (the second
// of the last write to leads, notes, tasks, reminders or the team, kept by
// SQLite triggers), so it reveals nothing about any lead.

/** The current change stamp. Any signed-in, active user may read it. */
export async function changeStamp(ctx: DataContext, actor: Actor): Promise<number> {
  void actor;
  const row = await ctx.db.query.changeVersion.findFirst({ where: eq(changeVersion.id, 1) });
  return row?.version ?? 0;
}
