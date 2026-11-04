# Office portal page (`/office`)

The sidebar's **Office portal** page joins the LMS to the Capitup AI site's
staff console at `https://capitupindia.com/office` (policy uploads, gap
reports, call requests and renewals).

## What it does

- **Everyone** gets an "Open office portal" button (new tab). Staff sign in
  there with their own office account; the LMS never sees that password.
- When the LMS has an office account of its own (below), the page also shows
  the portal's numbers: policies uploaded, gap reports, call requests,
  renewals due in 30 days, reports with a high gap, games played, and
  breakdowns by policy type, call-request status and the 30-day funnel.
- **Admins only** also see the client renewal list (client name, phone,
  policy, end date, outreach status, gaps) and a Refresh button. Agents get the
  counts but no client details, the same rule as the LMS's own all-leads views
  (`src/server/data/office.ts`, tested in `__tests__/office.test.ts`).

## How it talks to the portal

The office backend (FastAPI, `backend/app/main.py` in the capitup repo) has no
API keys. `POST /api/admin/login` takes an email and password and sets an
httpOnly session cookie; `GET /api/admin/stats` and `GET /api/admin/renewals`
need that cookie. `src/server/office/portal.ts` signs in on the server, keeps
the cookie in memory, and caches the snapshot for 5 minutes per Worker
isolate (failures for 1 minute; a forced refresh at most every 30 seconds).
Nothing about the office is stored in D1, so there is no migration.

Free plan: a page view normally makes no outbound call. A refresh is 2
subrequests (3 with a sign-in), far under the Free limit of 50 per request.

## Switching on the live numbers

1. **Office side.** As the office super admin, add a separate account for the
   LMS with the ordinary *admin* role (read and download, no user
   management), e.g. `lms-reader@capitupindia.com`, with a 12+ character
   password.
2. **Office side.** Add the LMS address to the office backend's
   `ALLOWED_ORIGINS` (comma separated), e.g.
   `ALLOWED_ORIGINS=https://capitupindia.com,https://lms.capitupindia.com`,
   and restart the API. Without it the office refuses the sign-in (403).
3. **Cloudflare.** On the `capitup-lms-web` Worker, add two **Secrets**:
   `OFFICE_EMAIL` and `OFFICE_PASSWORD`. Optional var `OFFICE_PORTAL_URL`
   (default `https://capitupindia.com`; must be https).

Every LMS read appears in the office audit log as `login`, `view_stats` and
`view_renewals` by that account.
