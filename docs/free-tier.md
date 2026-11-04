# Running on the Cloudflare Workers Free plan

The app has to fit inside these Free plan limits (Cloudflare's published
limits as of November 2026; check the Workers, D1 and R2 pricing pages
before you rely on a number):

| Limit (Free plan)                      | Value            | Where the app stood before this change                 |
| -------------------------------------- | ---------------- | ------------------------------------------------------ |
| Worker size (gzipped upload)           | 3 MB             | 4.9 MB, so a deploy on Free gets refused               |
| CPU time per request                   | 10 ms            | My Day ~1 s, Team ~0.9 s, Analytics ~1.2 s (local)     |
| Memory per isolate                     | 128 MB           | Sign-in fixed in PR #18 (PBKDF2 instead of scrypt)     |
| Requests per day                       | 100,000          | Fine: about 2,000 polls plus 1,440 cron runs a day     |
| D1 rows read per day                   | 5 million        | At risk: every open tab re-rendered every minute       |
| D1 rows written per day                | 100,000          | Fine                                                    |
| D1 storage                             | 500 MB per DB    | Fine (about 1,000 leads)                                |
| R2 storage / operations per month      | 10 GB / 1M + 10M | Fine (visiting cards only)                              |

## What was changed

1. **Bundle under 3 MB.** `next build --webpack` (Turbopack copied Better
   Auth, Zod and the Gemini SDK into a chunk per route and shipped the
   `next/og` WASM) plus `minify: true` in `wrangler.jsonc`: 4.9 MB to 2.7 MB
   gzipped. Check with `npx wrangler deploy --dry-run`.
2. **Date formatting.** `Intl.DateTimeFormat` was built on every call (several
   per table row, about 6,000 for the analytics months). Formatters are now
   made once per isolate, and IST dates use the fixed +05:30 offset. This was
   most of the CPU time on every page.
3. **Analytics in SQL.** `pipelineAnalytics` (My Day, Team, Analytics) loaded
   every lead into the Worker to count them. D1 now does the counting with
   `GROUP BY`; the output is identical (checked against the old code on the
   imported data for every user and three dates).
4. **Paged leads list.** The table and cards show 100 leads a page (was up to
   500 in one page, 1.9 MB of HTML). The board shows up to 50 cards per
   column, with the real column totals.
5. **Auto-refresh only on change.** Open tabs used to re-render the whole page
   every minute. They now ask `/api/changes` for one number (bumped by SQLite
   triggers, at most once a second, see `migrations/0003_change_version.sql`)
   and re-render only when it moved, or after 10 minutes as a safety net.
6. **Reused auth and database objects.** Better Auth and Drizzle are built once
   per isolate instead of on every request.
7. **Reminder batches of 100.** The per-minute cron handles at most 100 due
   reminders per run, so a backlog drains over a few minutes instead of one
   run exceeding the CPU limit.

## Measurements (local, same data as production)

Local `wrangler dev` with the 1,031 imported leads, CPU time of the `workerd`
process averaged over 15 requests per page. Local numbers include the local
SQLite work that production does outside the Worker, so they are higher than
what Cloudflare bills, and are only good for before/after comparison.

| Page (signed in as)        | Before   | After  |
| -------------------------- | -------- | ------ |
| My Day (admin)             | 1,026 ms | 88 ms  |
| My Day (agent, 900 leads)  | 471 ms   | 63 ms  |
| Leads table (admin)        | 409 ms   | 74 ms  |
| Leads board (admin)        | 217 ms   | 79 ms  |
| Team (admin)               | 875 ms   | 39 ms  |
| Analytics (admin)          | 1,223 ms | 42 ms  |
| Calendar (admin)           | 48 ms    | 38 ms  |
| Auto-refresh check         | a full page render | 15 ms |

## What still isn't guaranteed

Even a tiny Next.js request costs a few milliseconds of CPU, and the first
request on a fresh isolate also loads the page's code. Pages are now 10 to 25
times cheaper, but it can't be promised that every request stays under 10 ms.
After deploying, check Workers Logs for "exceeded CPU time limit". If it
still shows up regularly, the Paid plan ($5/month, 30 s CPU per request) is
the dependable fix.

Next candidates if needed: the Duplicates page (renders every duplicate
group, about 1 MB of HTML), and replacing the `@google/genai` SDK with a
direct `fetch` (about 120 KB gzipped of bundle headroom).
