# Going live

The app runs on three hosted services: **Supabase** (database, sign-in, file storage),
**Vercel** (the website) and **Inngest** (the every-minute job that delivers renewal
reminders). Do the steps in order; each one needs the previous one.

Secrets (the Supabase secret key, database password, Gemini key, Inngest keys) go
straight into the Vercel, Supabase or GitHub settings screens. Never paste them into
chat, a file in this repository, or a variable starting with `NEXT_PUBLIC_`.

## 1. Supabase project

1. At [supabase.com/dashboard](https://supabase.com/dashboard), create a project.
   Region: **South Asia (Mumbai)**, so the database sits next to the Vercel functions
   (`vercel.json` pins them to Mumbai, `bom1`). Use a database password made of letters
   and digits only, and keep it in a password manager.
2. **Authentication > Sign In / Providers**: turn **off** "Allow new users to sign up".
   Accounts are created by an admin only. (The repo's `supabase/config.toml` sets this
   for local development, but hosted projects ignore that file.) Leave the Email
   provider itself on, since people sign in with email and password.
3. **Authentication > URL Configuration**: set Site URL to the Vercel address once
   you have it (step 3).

## 2. Database schema

Migrations are applied by the **Apply database migrations** GitHub Action, so nothing
needs installing.

1. In Supabase, click **Connect** and copy the **Session pooler** connection string.
   Replace `[YOUR-PASSWORD]` with the database password.
2. In GitHub, open the repository's **Settings > Secrets and variables > Actions** and
   add a repository secret named `SUPABASE_DB_URL` with that string.
3. **Actions > Apply database migrations > Run workflow**. The first run is a dry run
   and lists the five migrations it would apply. Run it again with "dry run" unticked
   to apply them.

Later schema changes ship the same way: merge the PR, then run the workflow.

Check: in Supabase, **Table Editor** shows `leads`, `profiles`, `events` and the rest,
and **Storage** has a private `visiting-cards` bucket.

## 3. Vercel

1. At [vercel.com/new](https://vercel.com/new), import this GitHub repository. The
   framework preset (Next.js) and build settings are detected; change nothing.
2. Before the first deploy, add these environment variables (Production):

   | Name | Where to find it |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase > Project Settings > Data API > Project URL |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase > Project Settings > API Keys > Publishable key |
   | `SUPABASE_SECRET_KEY` | Supabase > Project Settings > API Keys > Secret key (mark it Sensitive) |
   | `GEMINI_API_KEY` | Google AI Studio; the rotated key, never the one in the old APK (mark it Sensitive) |

3. Deploy, then copy the production address (for example
   `https://capitupindia-lms-web.vercel.app`) into Supabase's Site URL (step 1.3).

## 4. Inngest (renewal reminders)

1. In Vercel, add the **Inngest** integration from the Marketplace
   ([vercel.com/integrations/inngest](https://vercel.com/integrations/inngest)) and give
   it access to this project. It sets `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` on
   the project and registers `/api/inngest` on every deploy.
2. Redeploy once in Vercel (Deployments > the latest one > Redeploy) so the new keys
   are picked up.
3. In the Inngest dashboard, the app `capitupindia-lms` should show the function
   **Deliver renewal reminders** with a run every minute.

Do not set `INNGEST_DEV` in Vercel; it is for local development only.

The job runs every minute (about 44,000 runs a month) because the last milestone is
five minutes before renewal. Check that this fits your Inngest plan.

## 5. First admin and the team

1. Supabase > **Authentication > Users > Add user > Create new user**: your email and a
   password, with "Auto confirm user" ticked. Repeat for each agent. To set the display
   name, add `{"full_name": "Sravani"}` as user metadata.
2. Promote yourself in **SQL Editor**:

   ```sql
   update public.profiles set role = 'ADMIN' where email = 'you@capitupindia.com';
   ```

3. Sign in at the Vercel address. From then on, roles and deactivation are managed in
   the app under **Admin > Team**.

## Smoke test

- Sign in as the admin; My Day loads.
- In Inngest, **Deliver renewal reminders** shows a successful run every minute.
- Create a lead with tomorrow as its renewal date. Calendar shows the due event at once,
  and the notification bell shows each countdown reminder (T-24 Hours, T-10 Hours, ...)
  within a minute of it falling due.
- Paste a sentence into **Intake**; with the Gemini key set, fields come back filled by AI
  (AI Usage shows the call and its rupee cost).
- Sign in as an agent in a private window: only that agent's leads are visible.

## Loading the old app's data

The Firebase import is a separate one-time step (see the Firebase migration PR). Run it
only after the agent accounts in step 5 exist.
