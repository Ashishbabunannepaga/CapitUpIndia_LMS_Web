import { createDataContext } from "@/server/data/context";
import { deliverDueReminders } from "@/server/data/notifications";

/** The per-minute Cron Trigger: send renewal reminders that are due. */
export async function runScheduled(env: CloudflareEnv): Promise<void> {
  const ctx = createDataContext(env.DB, env, env.CARDS);
  const delivered = await deliverDueReminders(ctx);
  if (delivered > 0) console.log(`Delivered ${delivered} renewal reminder notification(s).`);
}
