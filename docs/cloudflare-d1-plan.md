# Moving the LMS to Cloudflare Workers + D1 + R2

Decision (Ash, 2026-10-09): the database moves from Supabase to Cloudflare D1.
Everything runs on one Cloudflare account. Supabase, Vercel and AWS are no
longer part of the launch.

## Target setup

| Today (Supabase stack)                | After the move                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| Vercel / AWS hosting                  | Cloudflare Workers, Next.js 16 built with the OpenNext adapter                   |
| Supabase Postgres                     | D1 (SQLite), schema and migrations through Drizzle ORM + `wrangler d1 migrations` |
| Supabase Auth (email + password)      | Better Auth on D1: email + password, sessions in D1, no public sign-up          |
| Row-level security + guard triggers   | One server-side data layer that every page and action goes through (below)      |
| pg_trgm duplicate search              | SQLite FTS5 trigram index to find candidates, same similarity score in code     |
| Renewal milestone triggers            | Recomputed in the same D1 batch as the lead write                               |
| Inngest cron every minute             | Workers Cron Trigger every minute calling the reminder job                      |
| Supabase Storage (visiting cards)     | Private R2 bucket, files only served through a signed-in route                  |
| Supabase Realtime refresh             | Refresh on focus plus a light 30-second poll of a "last changed" stamp          |
| Gemini key in Vercel env              | Worker secret `GEMINI_API_KEY`, entered by Ash in the Cloudflare dashboard      |

Why OpenNext and not vinext: Cloudflare now recommends vinext for new apps, but
it is still in beta. OpenNext runs the real `next build` output, so the app's
server actions, proxy and route handlers behave as they do today. Revisit
vinext once it leaves beta.

## How access rules stay safe without RLS

Postgres enforced "who can see what" for every query. D1 has no such layer, so
the app gets one:

- `src/server/data/*` is the only code that imports the D1 binding. ESLint
  blocks importing the database anywhere else, and pages, server actions and
  route handlers call data functions, never SQL.
- Every data function takes the signed-in actor (`{ id, role, isActive }`) as
  its first argument, loaded once per request from the session. Inactive users
  are rejected before any query runs.
- Agent scope is applied inside the query (`WHERE assigned_agent_id = ?`), so a
  lead id from another agent returns nothing, exactly like RLS did.
- Forged fields are dropped by the Zod schemas and the write functions set
  server-owned columns themselves (`created_by`, `is_duplicate`, note signer,
  card path, assignment history). Non-admins cannot change role, owner or
  duplicate flags.
- SQLite triggers still do what needs no user context: `updated_at`, audit log
  rows, and blocking deletion of the last admin.

The existing 70+ database tests (`supabase/tests/*.sql`) are rewritten as
Vitest tests that run against a real in-memory D1 (`freshD1()` in
`src/server/db/test-d1.ts`, the same SQLite build as production), one test per rule, plus the forged-field and
cross-agent cases. The Playwright suite keeps running against the built Worker
(`wrangler dev`) and moves from "call the Supabase API directly" to "call the
app's routes and actions directly".

## Work, in order (one PR each where it helps review)

1. **Platform** (done in this PR): OpenNext + Wrangler config, D1 + R2 bindings, local dev with
   `wrangler`, CI building the Worker. Drizzle schema for all tables, first
   D1 migration, generated types replacing `database.types.ts`.
   Commands: `npm run cf:build` builds the Worker, `npx wrangler dev` runs it,
   `npm run d1:generate` writes a migration after a schema change,
   `npm run d1:migrate:local` applies migrations to the local D1.
2. **Auth** (done in this PR): Better Auth (email + password, admin-created users only), login,
   sign-out, session check in `src/proxy.ts`, the safe `next` redirect, a
   "create user" screen for admins, and a password reset admins can trigger.
   Done so far: `src/server/auth.ts` (sessions in D1, sign-up off, 5 sign-in
   tries per minute per IP, cross-site posts refused), `src/server/data/actor.ts`
   (a deactivated user is cut off on their next request), team accounts in
   `src/server/data/users.ts`, and `createFirstAdmin` for a new deployment.
   The screens switch over in step 3 together with the data.
3. **Data layer + access rules** (done in this PR): leads, notes, POC contacts, events,
   notifications, profiles, settings, audit; every rule from the SQL tests as
   a Vitest case.
4. **Duplicates** (done in this PR): company-name normalisation (shared fixture already exists),
   FTS5 trigram candidates, scoring and the "handled by" warning.
5. **Renewals and reminders** (done in this PR, except the cron wiring and
   round-robin, which land with step 6): milestone sync on lead write,
   `deliverDueReminders()`, tasks.
6. **AI and import**: Gemini intake/OCR (cards read from R2), bulk import in
   D1 batches, AI usage and cost tables, analytics queries rewritten for SQLite.
7. **Firebase import**: the migration thread's importer re-targeted to emit D1
   SQL (or call the data layer) instead of Postgres SQL; dry run against a
   local D1 first.
8. **Cut-over**: create the production D1 database and R2 bucket, deploy, Ash
   creates the first admin, run the import, then remove the Supabase code,
   the Vercel config and the old Inngest wiring.

The app stays shippable on Supabase until step 8; the switch happens in one
deploy.

## What only Ash does

1. Pick the plan. The Workers Free plan now hard-stops D1 at its daily row
   read/write limits (enforced since 2026-09-01). A small team likely fits,
   but Workers Paid (USD 5/month) removes the risk of the app stopping mid-day.
   Recommended: Paid.
2. Before cut-over: add `GEMINI_API_KEY` and `BETTER_AUTH_SECRET` as Worker
   secrets in the dashboard (never in chat). Claude creates the D1 database
   and R2 bucket through the Cloudflare connector when Ash says go.
3. Connect the custom domain in Cloudflare (DNS is already there).
4. After launch: pause or delete the Supabase project and the Vercel project.
