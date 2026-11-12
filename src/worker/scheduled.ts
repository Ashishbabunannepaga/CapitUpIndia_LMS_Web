import { appLeadsFeed } from "@/server/appfeed/feed";
import { syncAppWithdrawals } from "@/server/data/app-leads";
import { createDataContext } from "@/server/data/context";
import {
  CHECK_EVERY_MINUTES,
  recordAppError,
  runMonitor,
  sendDailySummary,
  type AlertSender,
  type SiteProbe,
} from "@/server/data/monitoring";
import { deliverDueReminders } from "@/server/data/notifications";
import { pushPendingNotifications, type PushSender } from "@/server/data/push";
import { vapidKeysFrom } from "@/server/push/config";
import { sendWebPush } from "@/server/push/web-push";
import { alertSender, healthUrl, probeSite } from "@/server/monitoring/alerts";

/** Swapped out in tests. */
export type ScheduledDeps = {
  send?: AlertSender;
  probe?: SiteProbe;
  sleep?: (ms: number) => Promise<void>;
  /** Browser push sender; by default Web Push with the VAPID secrets, when they are set. */
  push?: PushSender | null;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The per-minute Cron Trigger: send renewal reminders that are due; every 15
 * minutes stop LMS leads whose CapitUp app user withdrew consent; every 5
 * minutes run the health check (src/server/data/monitoring.ts); and at 09:00
 * IST send the daily monitoring report.
 */
export async function runScheduled(env: CloudflareEnv, at = new Date(), deps: ScheduledDeps = {}): Promise<void> {
  const ctx = createDataContext(env.DB, env, env.CARDS);
  const send = deps.send ?? alertSender(env);

  try {
    const delivered = await deliverDueReminders(ctx, at);
    if (delivered > 0) console.log(`Delivered ${delivered} renewal reminder notification(s).`);
  } catch (error) {
    console.error("Renewal reminder delivery failed", { message: message(error) });
    await recordAppError(ctx, { source: "job", path: "Renewal reminders", message: message(error) }, at);
  }

  // Whatever landed in a bell this minute (reminders, assignments) also goes
  // to the person's browsers that allowed push. Needs the VAPID secrets.
  const vapid = vapidKeysFrom(env);
  const push = deps.push !== undefined ? deps.push : vapid ? ((target, msg) => sendWebPush(target, msg, vapid)) satisfies PushSender : null;
  if (push) {
    try {
      const pushed = await pushPendingNotifications(ctx, push, at);
      if (pushed > 0) console.log(`Pushed ${pushed} browser notification(s).`);
    } catch (error) {
      console.error("Browser push failed", { message: message(error) });
      await recordAppError(ctx, { source: "job", path: "Browser push", message: message(error) }, at);
    }
  }

  const minute = at.getUTCMinutes();
  if (minute % 15 === 0) {
    try {
      const stopped = await syncAppWithdrawals(appLeadsFeed, ctx);
      if (stopped > 0) console.log(`Marked ${stopped} lead(s) do-not-contact after app consent was withdrawn.`);
    } catch (error) {
      console.error("App withdrawal sync failed", { message: message(error) });
      await recordAppError(ctx, { source: "job", path: "App consent sync", message: message(error) }, at);
    }
  }

  if (minute % CHECK_EVERY_MINUTES === 0) {
    try {
      await runMonitor(ctx, { siteUrl: healthUrl(env), probe: deps.probe ?? ((url) => probeSite(url)), send, sleep: deps.sleep }, at);
    } catch (error) {
      console.error("Health check failed", { message: message(error) });
    }
  }

  // 03:30 UTC is 09:00 in India.
  if (at.getUTCHours() === 3 && minute === 30) {
    try {
      await sendDailySummary(ctx, send, at);
    } catch (error) {
      console.error("Daily monitoring report failed", { message: message(error) });
    }
  }
}
