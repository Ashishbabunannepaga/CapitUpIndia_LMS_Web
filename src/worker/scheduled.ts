import { todayInBusinessTz } from "@/lib/dates";
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
import { rollAutoRenewals } from "@/server/data/leads";
import { deliverDueReminders, deliverTaskReminders } from "@/server/data/notifications";
import { generate } from "@/lib/ai/client";
import { MAX_OUTPUT_TOKENS, MODEL_CHAINS } from "@/lib/ai/models";
import { dayPlanPrompt, teamRiskPrompt } from "@/lib/ai/prompts";
import { sendDayPlans, type PlanWriter } from "@/server/data/day-plan";
import { runPlaybooks } from "@/server/data/playbooks";
import { deliverTaskDueReminders } from "@/server/data/task-reminders";
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
  /** Writes the 09:00 day plans; by default OpenAI through generate(). */
  planWriter?: PlanWriter;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The per-minute Cron Trigger: send renewal reminders that are due (and
 * escalate ignored T-10 / T-3 ones to admins), remind people of tasks and
 * meetings, walk Task Grid tasks up their due-time ladder, push all of it to browsers; every 15
 * minutes stop LMS leads whose CapitUp app user withdrew consent; every 5
 * minutes run the health check (src/server/data/monitoring.ts); and at 09:00
 * IST send everyone their day plan and the daily monitoring report.
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

  try {
    const reminded = await deliverTaskReminders(ctx, at);
    if (reminded > 0) console.log(`Delivered ${reminded} task and meeting reminder(s).`);
  } catch (error) {
    console.error("Task reminder delivery failed", { message: message(error) });
    await recordAppError(ctx, { source: "job", path: "Task reminders", message: message(error) }, at);
  }

  try {
    const nudged = await deliverTaskDueReminders(ctx, at);
    if (nudged > 0) console.log(`Sent ${nudged} Task Grid due-time reminder(s).`);
  } catch (error) {
    console.error("Task Grid reminders failed", { message: message(error) });
    await recordAppError(ctx, { source: "job", path: "Task Grid reminders", message: message(error) }, at);
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
  // Hourly: Auto Renewed (term life) policies whose date passed renewed themselves.
  if (minute === 7) {
    try {
      const rolled = await rollAutoRenewals(ctx, todayInBusinessTz(at));
      if (rolled > 0) console.log(`Moved ${rolled} auto-renewed polic${rolled === 1 ? "y" : "ies"} to next year.`);
    } catch (error) {
      console.error("Auto-renewal roll failed", { message: message(error) });
      await recordAppError(ctx, { source: "job", path: "Auto renewals", message: message(error) }, at);
    }
  }

  // Hourly: renewal playbook steps whose date has come become tasks.
  if (minute === 17) {
    try {
      const steps = await runPlaybooks(ctx, at);
      if (steps > 0) console.log(`Created ${steps} renewal playbook task(s).`);
    } catch (error) {
      console.error("Renewal playbooks failed", { message: message(error) });
      await recordAppError(ctx, { source: "job", path: "Renewal playbooks", message: message(error) }, at);
    }
  }

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
      const writer: PlanWriter =
        deps.planWriter ??
        (async (person, kind, facts, admin) => {
          const today = todayInBusinessTz(at);
          const { value } = await generate({
            ctx,
            user: person,
            feature: "other",
            models: MODEL_CHAINS.summary,
            system: kind === "plan" ? dayPlanPrompt(today, admin) : teamRiskPrompt(today),
            maxOutputTokens: MAX_OUTPUT_TOKENS.dayPlan,
            text: facts,
            parse: (out) => {
              const clean = out.trim();
              if (!clean) throw new Error("Empty plan");
              return clean;
            },
          });
          return value;
        });
      const plans = await sendDayPlans(ctx, at, writer);
      if (plans > 0) console.log(`Sent ${plans} morning plan(s) and team report(s).`);
    } catch (error) {
      console.error("Morning plans failed", { message: message(error) });
      await recordAppError(ctx, { source: "job", path: "Morning plans", message: message(error) }, at);
    }
    try {
      await sendDailySummary(ctx, send, at);
    } catch (error) {
      console.error("Daily monitoring report failed", { message: message(error) });
    }
  }
}
