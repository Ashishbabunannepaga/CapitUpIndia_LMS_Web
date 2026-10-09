# CapitUp India LMS (web)

Insurance lead management and policy renewal CRM for CapitUp India: capture leads,
prevent duplicate outreach, assign them to agents, and never miss a renewal.

This repository is the web rebuild of the existing Android app. Business rules come
from the parity spec of that app; the stack is Next.js (App Router), TypeScript,
Tailwind CSS, shadcn/ui and Lucide on the front end, running on Cloudflare Workers
(through OpenNext) with D1 for data, R2 for visiting cards and Better Auth for sign-in.

## Getting started

1. Install dependencies: `npm install`
2. Copy `.dev.vars.example` to `.dev.vars`. Add `GEMINI_API_KEY` for the AI features;
   without it the app falls back to basic extraction and standard follow-up drafts, and
   card scanning is unavailable.
3. Create the local database: `npm run d1:migrate:local`
4. `npm run dev` and open http://localhost:3000/setup to create the first admin with the
   `SETUP_CODE` from `.dev.vars`. Add agents under **Team**.

`npm run dev` runs Next.js with local D1 and R2 bindings. To run the real Worker,
including the every-minute reminder cron, use `npm run cf:build && npx wrangler dev --test-scheduled`
and open `/__scheduled` to fire the cron by hand.

To put the app online, follow [docs/deploy.md](docs/deploy.md). Why and how the app moved
from Supabase to D1 is in [docs/cloudflare-d1-plan.md](docs/cloudflare-d1-plan.md).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Next.js production build |
| `npm run cf:build` | Builds the Cloudflare Worker (`.open-next/`) |
| `npm run cf:deploy` | Builds and deploys the Worker with your Wrangler login |
| `npm run lint` | ESLint |
| `npm run typecheck` | Route type generation and `tsc` |
| `npm test` | Unit tests, and every access rule against a real in-memory D1 (Vitest) |
| `npm run test:e2e` | Browser and HTTP tests (Playwright) against the built Worker with a fresh local D1 |
| `npm run d1:generate` | Writes a migration after a change to `src/server/db/schema.ts` |
| `npm run d1:migrate:local` | Applies migrations to the local D1 |

## Data model

| Table | Purpose |
| --- | --- |
| `user`, `session`, `account` | Better Auth sign-in accounts and sessions |
| `profiles` | One row per account: name, email, role (`ADMIN` / `AGENT`), active flag |
| `leads` | Company, New/Renewal, Corporate/Retail, product, sub-product, renewal date, POC 1 and 2, notes, status, assigned agent, duplicate state, visiting card |
| `events` | Visible calendar events and background renewal reminders (`T-30 Days` ... `T-5 Minutes`) |
| `lead_notes` | Append-only, timestamped agent notes, rendered as `[Agent Name - DD MMM YYYY, HH:mm]: Note` |
| `lead_note_reads` | Per-user read receipts for the "new notes" badge |
| `ai_usage_logs` | Every Gemini call: user, feature, model, tokens and INR cost |
| `ai_model_pricing`, `app_settings` | Central pricing, USD to INR rate, renewal due time and timezone |
| `notifications` | Delivered renewal reminders, per user, with a read flag |
| `audit_logs` | Who changed leads, profiles, notes, pricing and settings |

Statuses are Prospect, Quoted, Active Client, Follow-up, Closed Won and Closed Lost.
Products are Health, Fire or Property, Life, Motor, Liability, Travel, Marine and Credit.

## Rules the data layer enforces

Every page, action and route calls a function in `src/server/data/` with the signed-in
user; nothing else may import the database (ESLint enforces it).

- **Access.** Agents see and edit only leads assigned to them, the events assigned to
  them and the notes on those leads. They can create leads only for themselves, cannot
  reassign, delete, or change duplicate state. Admins see everything. A disabled user is
  signed out everywhere and refused on their next request. There is no public sign-up.
- **Duplicates.** Company names are normalized (case, punctuation, legal suffixes like
  Pvt Ltd). An exact normalized match marks the new lead as a duplicate with the other
  agents' names. A trigram index finds fuzzy matches before saving, so "Renee Systems
  India Pvt Ltd" finds "Renee Systems". Only admins clear the flag.
- **Renewal countdown.** Setting or changing a renewal date writes one visible due event
  (10:00 IST on the renewal date by default) and background reminders at T-30, T-10, T-5
  and T-3 days, T-24, T-10 and T-1 hours, and T-30 and T-5 minutes. Reassigning the lead
  moves its reminders. The Worker's Cron Trigger runs every minute and turns due reminders
  into notifications for the lead's agent (or every admin when it is unassigned), skips
  closed leads, and sends each reminder exactly once.
- **Round-robin.** Bulk imports hand out active agents in name order and remember where
  the last import stopped.
- **AI cost.** Each call is priced in rupees from `ai_model_pricing` and the exchange rate.
- **Notes.** Author and timestamp come from the session, not the client.
- **Last admin.** A D1 trigger refuses to demote, disable or delete the last active admin.

## AI features

Gemini is called only from the server, with the `GEMINI_API_KEY` Worker secret, and each
feature tries a chain of models before giving up.

| Feature | Where | Falls back to |
| --- | --- | --- |
| Lead intake from notes or dictation | `/intake` | Pattern-based extraction |
| Visiting card OCR | `/intake` | Unavailable; the form can be filled by hand |
| Follow-up writer (Professional, Warm, Concise, Benefit-focused) | Lead page | A standard draft |
| Bulk sheet column mapping | `/admin/import` | Heuristic column matching, per batch |

What the AI returns is never trusted as-is. Server-side rules drop placeholder numbers and
emails, drop numbers, emails and designations that are not in the text the user supplied,
normalize products to the eight supported ones, turn loose dates ("23 rd Feb Renewal",
"20-Apr") into real dates, and leave a field empty rather than invent one. Everything is
shown for review before it is saved, and what was dropped is listed.

## Security notes

- Sign-in allows 5 attempts a minute per address and refuses cross-site posts.
  Sessions last 7 days and live in D1, so disabling someone or resetting their password
  ends them at once.
- `/setup` creates the first admin only while there are no accounts and only with the
  `SETUP_CODE` secret; remove the secret afterwards.
- `GEMINI_API_KEY` is read only on the server (`src/lib/ai/gemini.ts`). The old Android
  app shipped its key inside the APK; that key must stay out of this repository.
- Visiting card photos live in a private R2 bucket under the uploader's id. They are
  served only by `/leads/<id>/card`, to people who can see that lead, with `nosniff`
  and a sandboxing CSP.
- Agents are limited to `ai_hourly_limit_per_user` Gemini calls an hour (200 by default).
- `src/proxy.ts` only redirects visitors without a session cookie; the real checks happen
  on the server (`src/lib/auth.ts`) and in the data layer.
- The old app's plaintext passwords and name-based identity are not carried over.

## Project layout

```
src/
  app/
    login/, setup/      Sign-in and the first-run admin page
    auth/signout/       Sign-out route
    api/auth/           Better Auth endpoints
    (app)/              Signed-in area with the app shell
      my-day, leads, calendar, intake
      leads/[id]/card/  Visiting card photo route
      admin/            Admin-only screens (guarded in admin/layout.tsx)
  components/           App shell, leads, admin, analytics and shadcn/ui components
  lib/
    ai/                 Gemini client, prompts, schemas, deterministic clean-up
    import/             Sheet parsing and heuristic column mapping
    auth.ts             The signed-in user for pages and actions
    domain.ts           Statuses, products, milestones, note formatting
  server/
    auth.ts             Better Auth on D1
    db/                 Drizzle schema and the test D1
    data/               Every query and business rule, with their tests
  worker/               The reminder cron
migrations/             D1 migrations (generated, plus one hand-written for search and triggers)
worker.ts               Worker entry: the app plus the Cron Trigger
```
