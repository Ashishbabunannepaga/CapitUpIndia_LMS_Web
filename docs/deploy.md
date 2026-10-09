# Going live on Cloudflare

The whole app runs on one Cloudflare account: a **Worker** (the website and the
every-minute reminder job), a **D1** database and a private **R2** bucket for
visiting-card photos. Do the steps in order.

Secrets (`BETTER_AUTH_SECRET`, `GEMINI_API_KEY`, `SETUP_CODE`) go straight into the
Cloudflare dashboard. Never paste them into chat or commit them.

## 1. Plan

Workers Paid (USD 5 a month) is recommended. On the Free plan D1 stops answering for
the rest of the day once its daily read or write allowance is used up, which would take
the app down mid-day. Dashboard > **Workers & Pages > Plans**.

## 2. Database and bucket

Create them once (Claude can do this through the Cloudflare connector when you say go):

```sh
npx wrangler d1 create capitup-lms --location apac
npx wrangler r2 bucket create capitup-lms-visiting-cards
```

Put the new database id into `wrangler.jsonc` (`d1_databases[0].database_id`) and merge
that change.

## 3. Deploys from GitHub (Workers Builds)

Dashboard > **Workers & Pages > Create > Import a repository**, pick this repository,
then set:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Build command | `npm run cf:build` |
| Deploy command | `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy` |

Every merge to `main` then applies any new D1 migrations and deploys. Migrations only
add to the schema; they never run on their own outside a merge.

## 4. Secrets and settings

Worker > **Settings > Variables and Secrets**, type **Secret**:

| Name | Value |
| --- | --- |
| `BETTER_AUTH_SECRET` | A random string of 32+ characters (a password manager can generate one). Changing it later signs everyone out. |
| `BETTER_AUTH_URL` | The public address, e.g. `https://lms.capitupindia.com` |
| `GEMINI_API_KEY` | The rotated Google AI Studio key, never the one in the old APK |
| `SETUP_CODE` | Any 12+ character code you make up; used once in step 6 |

Redeploy after adding them (Deployments > latest > Retry deployment).

## 5. Domain

Worker > **Settings > Domains & Routes > Add > Custom domain**, e.g.
`lms.capitupindia.com`. The DNS record is created for you because the zone is on
Cloudflare. Make sure `BETTER_AUTH_URL` matches it.

## 6. First admin and the team

1. Open `https://<your domain>/setup`, enter the `SETUP_CODE`, your name, email and a
   password. The page closes for good once that account exists.
2. Delete the `SETUP_CODE` secret.
3. Sign in, open **Team**, and add each agent with a first password. Tell them the
   password in person; they keep it until an admin resets it.

## Smoke test

- Sign in as the admin; My Day loads.
- Create a lead with tomorrow as its renewal date. Calendar shows the due event at once,
  and the bell shows each countdown reminder within a minute of it falling due
  (Worker > **Logs** shows the cron running every minute).
- Paste a sentence into **Intake**; with the Gemini key set, fields come back filled by AI
  and **AI Usage** shows the call and its rupee cost.
- Sign in as an agent in a private window: only that agent's leads are visible.

## Loading the old app's data

The Firebase import is a separate one-time step: follow
[`migration/firebase/README.md`](../migration/firebase/README.md), after the agent
accounts exist.
