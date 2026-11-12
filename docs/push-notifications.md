# Push notifications

Everything that lands in the bell (renewal countdown reminders, and since
November 2026 "New lead assigned" messages) can also pop up as a notification
on each person's laptop or phone, even when the LMS is closed.

## How it works

1. The first time someone opens the LMS, a banner asks to **Turn on** alerts.
   The browser then asks for permission. The bell panel has the same switch
   (and a "Turn off").
2. The browser gives us a push subscription, which is saved in D1
   (`push_subscriptions`, one row per browser).
3. The per-minute cron (`src/worker/scheduled.ts`) pushes every new bell
   notification to its owner's browsers (`src/server/data/push.ts`), encrypted
   for that browser and signed with our VAPID key (`src/server/push/web-push.ts`,
   WebCrypto only). `public/sw.js` shows it; tapping it opens the lead.
4. Notifications older than an hour are not pushed (they stay in the bell).
   A browser the push service reports as gone (404/410) is deleted.

Assignments: an agent is told when someone else assigns them a lead (lead
form, reassign, office or app hand-over). A bulk import sends one
"12 new leads assigned to you" message per agent instead of one per lead.

## One-time setup (admin)

Push needs a VAPID key pair as two Worker **Secrets**. Until they are set,
the banner still works, but alerts only show while an LMS tab is open.

1. On any computer with Node.js 20+, in the repository folder:
   `node scripts/vapid-keys.mjs`
2. Cloudflare dashboard > Workers & Pages > `capitup-lms-web` > Settings >
   Variables and Secrets > Add, type **Secret**:
   - `VAPID_PUBLIC_KEY` = the first value
   - `VAPID_PRIVATE_KEY` = the second value
3. Deploy (or wait for the next deploy from `main`).

Keep the private key out of chat, email and git. If the keys are ever
changed, browsers re-subscribe automatically the next time the LMS is opened.

Optional: `VAPID_SUBJECT` (a `mailto:` or `https:` contact for the push
services). It defaults to the app's address.

## Phones

- Android (Chrome, Edge, Samsung Internet): works in the browser.
- iPhone and iPad (iOS 16.4+): Apple only allows web push for sites added to
  the Home Screen. Safari > Share > **Add to Home Screen**, open the LMS from
  the new icon, then turn alerts on. The bell panel says this on iPhones.
