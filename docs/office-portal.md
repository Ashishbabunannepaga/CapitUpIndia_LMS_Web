# Office portal (`/office`)

The sidebar's **Office portal** page is the capitupindia.com/office staff
console (Capitup AI: policy uploads, gap reports, call requests, renewals)
inside the LMS, so the team works it with their LMS login.

## Who sees what

Decided by Ash on 2026-11-04: **admins work the office and hand clients to
agents.**

| | Admin | Agent |
| --- | --- | --- |
| Portal counts (call requests, renewals due, uploads, gaps, funnel) | yes | yes |
| Call requests: list, client page, contact details, gap reports | yes | no |
| Change follow-up status and team notes | yes | no |
| **Hand to agent**: make the client an LMS lead | yes | no |
| Renewals due: list, outreach status, note, correct the end date | yes | no |
| Policies & reports, policy file download | yes | no |
| Saved protection-game results | yes | no |
| Clients handed to them | (all leads) | in their own Leads |

The rules live in `src/server/data/office.ts` and are tested in
`src/server/data/__tests__/office.test.ts`. The visitor's IP address, session
id and the policy text never leave the data layer; a report view shows only
the gap report, not the rest of the visitor's chat.

## Tabs (admins)

- **Overview**: waiting-for-a-call count, call requests, renewals due, uploads,
  high-gap reports, games; latest call requests; status, funnel, policy type,
  gap level and source breakdowns.
- **Call requests**: list with search and status chips (Open, New, Contacted,
  Follow-up, Became a client, Closed, All), 100 per page. The client page has
  Call / WhatsApp / Email, the five follow-up steps, contact details, team
  notes, the client's policies with their gap reports and files, earlier
  requests and saved games, and **Hand to an agent**.
- **Renewals due**: policies ending from 30 days ago to 90 days ahead, grouped
  by week / 30 days / 90 days, with the office's filters, KPIs, outreach status,
  note, end-date correction, WhatsApp renewal message and the policy file.
- **Policies & reports**: every upload with status, pages, copy type and OCR
  quality; open one to read its report and download it.
- **Protection game**: results visitors chose to save.

## Hand to an agent

Creates an ordinary LMS lead (`leads.office_lead_id` links it to the call
request, one lead per request): client and POC = the person, Retail, product
from the policy type, Renewal with the policy's end date when the report gave
one (so the usual T-30 ... T-5 minute reminders are created), and a note with
what they asked, best time, gap summary and marketing choice. The usual
duplicate check runs. The office request gets a note
`[LMS] Handed to <agent> as LMS lead #<id> by <admin>, <date>`.

## Data ownership

The public site keeps writing visitors, uploads, reports and call requests to
its own database (FastAPI on EC2). The LMS does not copy them into D1 or R2: it
reads and writes them through the office API (`src/server/office/portal.ts`)
and streams policy files through `/office/policies/<id>/download` without
storing them. Only handed-over leads live in D1. Office changes made from the
LMS are audited in both places: the office logs the LMS office account, and
the LMS `audit_logs` records the LMS person (`office_call_requests`,
`office_renewals`, `office_policy_downloads`).

## How it talks to the office

The office backend has no API keys. `POST /api/admin/login` sets an httpOnly
session cookie and returns a CSRF token; writes send it as `X-CSRF-Token` with
an `Origin` from the office's `ALLOWED_ORIGINS`. The portal client signs in on
the server, retries once on an expired session or stale token, caches the
overview for 5 minutes and other reads for 1 minute per Worker isolate, and
drops the caches after any write.

Free plan: a page view makes 1 to 3 subrequests (50 allowed); the Worker
bundle is about 2.77 MB gzipped (3 MB limit).

## Switching it on

1. **Office side.** As the office super admin, add an account for the LMS
   with the ordinary *admin* role (it can view, download and update call
   requests and renewals, not manage office users), e.g.
   `lms@capitupindia.com`, with a 12+ character password.
2. **Office side.** Add the LMS address to the office backend's
   `ALLOWED_ORIGINS` (comma separated), e.g.
   `ALLOWED_ORIGINS=https://capitupindia.com,https://lms.capitupindia.com`,
   and restart the API. Without it every sign-in and change is refused (403).
3. **Cloudflare.** On the `capitup-lms-web` Worker, add two **Secrets**:
   `OFFICE_EMAIL` and `OFFICE_PASSWORD`. Optional var `OFFICE_PORTAL_URL`
   (default `https://capitupindia.com`; must be https).

Migration `0004` adds `leads.office_lead_id`; the deploy command applies it.

Not ported: office user management and password change (office accounts stay
office-side; LMS logins are managed on Team).
