# CapitUp India LMS (web)

Insurance lead management and policy renewal CRM for CapitUp India: capture leads,
prevent duplicate outreach, assign them to agents, and never miss a renewal.

This repository is the web rebuild of the existing Android app. Business rules come
from the parity spec of that app; the stack is Next.js (App Router), TypeScript,
Tailwind CSS, shadcn/ui and Lucide on the front end, with Supabase (Postgres, Auth,
Realtime) behind it.

## Getting started

1. Install dependencies: `npm install`
2. Create a Supabase project (or run `npx supabase start` locally with Docker).
3. Apply the migrations: `npx supabase db push` (hosted) or `npx supabase db reset` (local).
4. Copy `.env.example` to `.env.local` and fill in the project URL, publishable key and secret key.
5. `npm run dev` and open http://localhost:3000.

### Creating the first admin

Public sign-up is disabled; accounts are created by an admin.

1. In the Supabase dashboard, go to Authentication > Users and add a user (or invite one).
   Set `full_name` in the user metadata to control the display name.
2. Every new user gets an `AGENT` profile automatically. Promote the first admin in the SQL editor:

   ```sql
   update public.profiles set role = 'ADMIN' where email = 'you@capitupindia.com';
   ```

After that, admins manage roles and deactivate users from the app; the database
refuses role changes from anyone else and never lets the last active admin be removed.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | Route type generation and `tsc` |
| `npm run db:test` | Applies all migrations to a throwaway Postgres and runs the access-control tests |
| `npm run db:types` | Regenerates `src/lib/database.types.ts` from a running local Supabase |

`db:test` needs PostgreSQL 15+ binaries (`initdb`, `pg_ctl`, `psql`) on the machine,
or set `DATABASE_URL` to an empty database. CI runs it against `postgres:17`.

## Data model

| Table | Purpose |
| --- | --- |
| `profiles` | One row per Supabase Auth user: name, email, role (`ADMIN` / `AGENT`), active flag |
| `leads` | Company, New/Renewal, Corporate/Retail, product, sub-product, renewal date, POC 1 and 2, notes, status, assigned agent, duplicate state, visiting card |
| `events` | Visible calendar events and background renewal reminders (`T-30 Days` ... `T-5 Minutes`) |
| `lead_notes` | Append-only, timestamped agent notes, rendered as `[Agent Name - DD MMM YYYY, HH:mm]: Note` |
| `lead_note_reads` | Per-user read receipts for the admin "new notes" badge |
| `ai_usage_logs` | Every Gemini call: user, feature, model, tokens and INR cost |
| `ai_model_pricing`, `app_settings` | Central pricing, USD to INR rate, renewal due time and timezone |
| `audit_logs` | Who changed leads, profiles, notes, pricing and settings |

Statuses are Prospect, Quoted, Active Client, Follow-up, Closed Won and Closed Lost.
Products are Health, Fire or Property, Life, Motor, Liability, Travel, Marine and Credit.

## Rules the database enforces

- **Access.** Agents see and edit only leads assigned to them, the events assigned to
  them and the notes on those leads. They can create leads only for themselves, cannot
  reassign, delete, or change duplicate state, and cannot read the audit log. Admins see
  everything. Disabled users see nothing. Anonymous users have no table access.
- **Duplicates.** Company names are normalized (case, punctuation, legal suffixes like
  Pvt Ltd). An exact normalized match marks the new lead as a duplicate with the other
  agents' names. `find_similar_leads()` uses `pg_trgm` for fuzzy matches before saving,
  so "Renee Systems India Pvt Ltd" finds "Renee Systems". Only admins clear the flag.
- **Renewal countdown.** Setting or changing a renewal date writes one visible due event
  (10:00 IST on the renewal date by default) and background reminders at T-30, T-10, T-5
  and T-3 days, T-24, T-10 and T-1 hours, and T-30 and T-5 minutes. Reassigning the lead
  moves its reminders. A server job delivers reminders where `reminder_sent_at` is null.
- **AI cost.** `cost_inr` is computed from `ai_model_pricing` and the configured exchange
  rate; only the server (service role) writes usage logs.
- **Notes.** Author and timestamp come from the session, not the client.

## Security notes

- `SUPABASE_SECRET_KEY` bypasses RLS. It is only read in `src/lib/supabase/admin.ts`
  (marked `server-only`) and must never be exposed with a `NEXT_PUBLIC_` prefix.
- `src/proxy.ts` refreshes the session and redirects signed-out visitors; real checks
  happen on the server (`requireProfile`, `requireAdmin`) and in RLS.
- The old app's plaintext passwords and name-based identity are not carried over;
  accounts live in Supabase Auth only.

## Project layout

```
src/
  app/
    login/              Sign-in page and server action
    auth/signout/       Sign-out route
    (app)/              Signed-in area with the app shell
      my-day, leads, calendar, intake
      admin/            Admin-only screens (guarded in admin/layout.tsx)
  components/
    app-shell/          Sidebar, page header, placeholders
    ui/                 shadcn/ui components
  lib/
    auth.ts             getCurrentProfile, requireProfile, requireAdmin
    domain.ts           Statuses, products, milestones, note formatting
    navigation.ts       Sidebar items per role
    supabase/           Browser, server, proxy and service-role clients
supabase/
  migrations/           Schema, access control, renewal milestones
  tests/                Plain-Postgres stub of Supabase and SQL tests
```
