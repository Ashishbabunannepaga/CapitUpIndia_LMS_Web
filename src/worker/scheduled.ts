import { appLeadsFeed } from "@/server/appfeed/feed";
import { syncAppWithdrawals } from "@/server/data/app-leads";
import { createDataContext } from "@/server/data/context";
import { deliverDueReminders } from "@/server/data/notifications";

/**
 * The per-minute Cron Trigger: send renewal reminders that are due, and every
 * 15 minutes stop LMS leads whose CapitUp app user withdrew consent.
 */
export async function runScheduled(env: CloudflareEnv, at = new Date()): Promise<void> {
  const ctx = createDataContext(env.DB, env, env.CARDS);
  const delivered = await deliverDueReminders(ctx);
  if (delivered > 0) console.log(`Delivered ${delivered} renewal reminder notification(s).`);
  if (at.getUTCMinutes() % 15 === 0) {
    try {
      const stopped = await syncAppWithdrawals(appLeadsFeed, ctx);
      if (stopped > 0) console.log(`Marked ${stopped} lead(s) do-not-contact after app consent was withdrawn.`);
    } catch (error) {
      console.error("App withdrawal sync failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }
}
