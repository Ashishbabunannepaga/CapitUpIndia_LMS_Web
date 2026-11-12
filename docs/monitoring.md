# Monitoring and alerts

The LMS checks itself and tells you when something breaks. Nothing here needs
a new Cloudflare resource: it runs on the existing per-minute Cron Trigger and
writes to the existing D1 database.

## What runs

| When | What | Code |
| --- | --- | --- |
| Every request | A 5xx answer or a crash is stored as a **server error** (after the response has gone out). | `worker.ts`, `src/worker/errors.ts` |
| Every browser crash | The error pages already report to `/api/client-errors`; reports from online browsers are stored as **browser errors**. | `src/app/api/client-errors/route.ts` |
| Every minute | Renewal reminders. If they fail, that is stored as a **failed background job** (so is the app-consent sync). | `src/worker/scheduled.ts` |
| Every 5 minutes | The **health check**: asks D1 `select 1`, loads `https://<app>/api/health` through CloudFront like a visitor, counts the errors above since the last check, and writes a `health_checks` row. | `src/server/data/monitoring.ts` |
| 09:00 IST daily | The **daily report**: uptime %, missed checks, page speed and error counts for the last 24 hours. | `sendDailySummary` |

A check is a **problem** when the database does not answer (retried once), the
site does not load or `/api/health` is not `ok` (retried once), there was any
server error or failed job, or 10+ browser crashes in 5 minutes.

On a problem you get one alert, a reminder every hour while it lasts, and a
"back to normal" message when it clears. Admins also see the first and last
in the app's bell. **Admin > System health** shows the current status, uptime
for 24 hours and 7 days, the last 24 checks, the last 50 errors, and has a
**Send test alert** button. Checks and errors are kept for 30 days.

`/api/health` is public and returns only
`{ "status": "ok", "db": "ok", "timestamp": "...", "version": "<deploy id>" }`
(HTTP 503 with `"error"` when D1 is down).

## Setting up alerts

All channels are optional Worker **secrets** (Workers & Pages > capitup-lms-web >
Settings > Variables and Secrets > Add > type **Secret**). Secrets survive
deploys; plain variables do not. Set one or more:

### Phone push with ntfy (recommended, free, no account)

1. Install the **ntfy** app (Play Store / App Store).
2. Pick a long random topic name, e.g. `capitup-lms-7f3k9q2x8m4w`. Anyone who
   knows it can read the alerts, so do not use something guessable.
3. In the app: **+** > Subscribe to topic > that name (server `ntfy.sh`).
4. Add the secret `ALERT_NTFY_TOPIC` = that name.
5. Open **Admin > System health > Send test alert**. The phone should buzz.

Problems arrive as urgent/high priority (they ring through Do Not Disturb if
you allow ntfy to); the daily report is low priority.

### Slack, Discord or Google Chat

Create an incoming webhook in the tool and add it as `ALERT_WEBHOOK_URL`.

### Telegram

Create a bot with @BotFather, send it any message, read your chat id from
`https://api.telegram.org/bot<token>/getUpdates`, then add
`ALERT_TELEGRAM_BOT_TOKEN` and `ALERT_TELEGRAM_CHAT_ID`.

### Email

Not built in: Cloudflare's email sending needs the domain's DNS on Cloudflare,
and capitupindia.com is still at the cPanel host. ntfy can forward to email
(its "Email" option), or UptimeRobot (below) emails you for full outages.

## The fallback: an outside checker

If the whole Worker is down, its own cron cannot run, so it cannot alert about
itself (the System health page then shows **Not checking** and missed checks).
Cover that with a free outside monitor:

1. Sign up at https://uptimerobot.com (free: 50 monitors, 5-minute checks).
2. New monitor > HTTP(s) > URL `https://lms.capitupindia.com/api/health`,
   interval 5 minutes. Optionally a Keyword monitor for `"status":"ok"`.
3. Alert contacts: your email (and their mobile app if you like).

## Where else to look

- **Workers Logs** (Cloudflare dashboard > the Worker > Logs): every check logs
  one JSON line with `"event":"health_check"`; browser crashes log
  `[client-error]`.
- Change the thresholds at the top of `src/server/data/monitoring.ts`.
