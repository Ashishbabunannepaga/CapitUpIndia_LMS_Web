import type { Alert, AlertSender, SiteResult } from "../data/monitoring";

// Where monitoring alerts go. Every channel is optional; set the ones you use
// as Worker secrets (see docs/monitoring.md):
//   ALERT_NTFY_TOPIC     push to the free ntfy phone app (https://ntfy.sh).
//                        Anyone who knows the topic can read it, so use a
//                        long random name, e.g. capitup-lms-7f3k9q2x8m.
//   ALERT_NTFY_SERVER    (var, optional) a self-hosted ntfy server; default https://ntfy.sh
//   ALERT_WEBHOOK_URL    a Slack, Discord or Google Chat incoming webhook
//   ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID   a Telegram bot message
// Admins' in-app bells get the down/recovered alerts regardless.

export type AlertEnv = {
  ALERT_NTFY_TOPIC?: string;
  ALERT_NTFY_SERVER?: string;
  ALERT_WEBHOOK_URL?: string;
  ALERT_TELEGRAM_BOT_TOKEN?: string;
  ALERT_TELEGRAM_CHAT_ID?: string;
  BETTER_AUTH_URL?: string;
  MONITOR_URL?: string;
};

const NTFY_PRIORITY = { urgent: 5, high: 4, default: 3, low: 2 } as const;
const TIMEOUT_MS = 10_000;

/** Which channels are set up, for the admin page. Never returns the values. */
export function configuredChannels(env: AlertEnv): string[] {
  const channels: string[] = [];
  if (env.ALERT_NTFY_TOPIC?.trim()) channels.push("Phone push (ntfy)");
  if (env.ALERT_WEBHOOK_URL?.trim()) channels.push("Webhook");
  if (env.ALERT_TELEGRAM_BOT_TOKEN?.trim() && env.ALERT_TELEGRAM_CHAT_ID?.trim()) channels.push("Telegram");
  return channels;
}

/** The app's public address, without a trailing slash. */
function appUrl(env: AlertEnv): string | null {
  const url = env.BETTER_AUTH_URL?.trim();
  return url ? url.replace(/\/+$/, "") : null;
}

/** The URL the monitor loads: MONITOR_URL if set, else <app>/api/health. */
export function healthUrl(env: AlertEnv): string | null {
  const override = env.MONITOR_URL?.trim();
  if (override) return override;
  const base = appUrl(env);
  return base ? `${base}/api/health` : null;
}

async function post(fetcher: typeof fetch, url: string, body: unknown, what: string): Promise<void> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${what} answered HTTP ${response.status}`);
}

/** Sends an alert to every configured channel; one failing does not stop the others. */
export function alertSender(env: AlertEnv, fetcher: typeof fetch = fetch): AlertSender {
  return async (alert: Alert) => {
    const link = appUrl(env) ? `${appUrl(env)}/admin/health` : undefined;
    const jobs: Promise<void>[] = [];
    const topic = env.ALERT_NTFY_TOPIC?.trim();
    if (topic) {
      const server = (env.ALERT_NTFY_SERVER?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
      jobs.push(
        post(
          fetcher,
          server,
          { topic, title: alert.title, message: alert.body, priority: NTFY_PRIORITY[alert.priority], tags: alert.tags, click: link },
          "ntfy",
        ),
      );
    }
    const webhook = env.ALERT_WEBHOOK_URL?.trim();
    if (webhook) {
      const text = `*${alert.title}*\n${alert.body}${link ? `\n${link}` : ""}`;
      // "text" for Slack and Google Chat, "content" for Discord.
      jobs.push(post(fetcher, webhook, { text, content: text.slice(0, 2000), title: alert.title, body: alert.body, kind: alert.kind }, "Webhook"));
    }
    const bot = env.ALERT_TELEGRAM_BOT_TOKEN?.trim();
    const chat = env.ALERT_TELEGRAM_CHAT_ID?.trim();
    if (bot && chat) {
      const text = `${alert.title}\n\n${alert.body}${link ? `\n${link}` : ""}`;
      jobs.push(post(fetcher, `https://api.telegram.org/bot${bot}/sendMessage`, { chat_id: chat, text, disable_web_page_preview: true }, "Telegram"));
    }
    const results = await Promise.allSettled(jobs);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    for (const f of failed) console.error("Monitoring alert channel failed.", f.reason instanceof Error ? f.reason.message : String(f.reason));
    if (jobs.length && failed.length === jobs.length) throw new Error("No alert channel accepted the alert.");
  };
}

/** Loads the public health endpoint the way a visitor would, with a 10 s limit. */
export async function probeSite(url: string, fetcher: typeof fetch = fetch): Promise<SiteResult> {
  const start = Date.now();
  const target = `${url}${url.includes("?") ? "&" : "?"}monitor=${start}`;
  try {
    const response = await fetcher(target, {
      headers: { "user-agent": "CapitUp-LMS-monitor", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - start;
    const body = (await response.json().catch(() => null)) as { status?: string } | null;
    const ok = response.ok && body?.status === "ok";
    return { status: response.status, ms, ok, error: ok ? undefined : response.ok ? "unexpected answer" : `HTTP ${response.status}` };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { status: 0, ms: Date.now() - start, ok: false, error: timedOut ? "no answer within 10 s" : "could not connect" };
  }
}
