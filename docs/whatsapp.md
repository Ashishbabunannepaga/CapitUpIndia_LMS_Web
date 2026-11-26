# WhatsApp task alerts

Task Grid alerts can also go to each person's WhatsApp, through the Meta
WhatsApp Cloud API. Each alert has **Done** and **Snooze 1h** buttons, and
pressing one updates the task in the LMS as that person. The team can also
reply, send voice notes, add tasks and ask questions on WhatsApp (section 5).

These alerts are sent:
- Due soon
- Due now
- Overdue
- Escalations
- New tasks
- Approvals needed
- Renewal playbook steps
- Repeating tasks

Code:
- `src/server/whatsapp/client.ts` sends the alerts and checks webhook signatures.
- `src/server/data/whatsapp.ts` holds the rules.
- `src/app/api/whatsapp/route.ts` is the webhook.
- `src/server/task-copilot.ts` answers questions and drafts tasks (shared with Tasks > Copilot).
- `src/worker/scheduled.ts` sends the alerts every minute.

## 1. Worker secrets (Cloudflare > Workers > capitup-lms-web > Settings > Variables and Secrets, type Secret)

| Name | What |
|---|---|
| `WHATSAPP_TOKEN` | Permanent token of the system user (`whatsapp_business_messaging`, `whatsapp_business_management`) |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone number ID (WhatsApp > API Setup) |
| `WHATSAPP_BUSINESS_ID` | WhatsApp Business Account ID |
| `WHATSAPP_APP_SECRET` | App settings > Basic > App secret (checks the webhook signature) |
| `WHATSAPP_VERIFY_TOKEN` | Any long random text you choose. You type the same text in Meta's webhook form |

Optional vars: `WHATSAPP_TEMPLATE` (default `lms_task_alert`) and `WHATSAPP_TEMPLATE_LANG` (default `en`).

## 2. Message template (WhatsApp Manager > Message templates > Create)

Meta reviews new templates, usually within minutes to a few hours.

- **Category:** Utility
- **Name:** `lms_task_alert`
- **Language:** English (`en`)
- **Body:**
  ```
  Hello, you have a task update from CapitUp LMS.

  Update: {{1}}
  Details: {{2}}

  Tap Done when it is finished, or Snooze 1h to be reminded in an hour.
  ```
  (Meta rejects a body that starts or ends with a variable, or has too little text around them.)
  Sample values: `{{1}}` = `Due now: Zenith renewal quote`, `{{2}}` = `P1 · due 26 Nov, 6:00 pm`.
- **Buttons:** Quick reply, `Done`. Quick reply, `Snooze 1h`. Keep them in this order.

## 3. Webhook (Meta app > WhatsApp > Configuration)

1. Callback URL: `https://<your LMS address>/api/whatsapp`. Admin > WhatsApp shows the exact address.
2. Verify token: the same text as `WHATSAPP_VERIFY_TOKEN`.
3. Press **Verify and save**.
4. Under Webhook fields, subscribe to **messages**.

## 4. Turn it on per person (Admin > WhatsApp)

1. Enter each person's mobile number. A 10-digit Indian number gets +91 added.
2. Tick **Alerts on** and press **Save**.
3. Press **Send test** to check that everything works end to end.

## 5. Messages from the team

Team members with **Alerts on** can also write to the number. Each message
acts as that person, under the same rules as the app.

- **Done** or **Snooze** (a button, a word or a voice note) on an alert closes or pauses that task.
- A swipe-reply to an alert goes into that task's chat. A voice note is kept with its transcript.
- `todo: ...` or `remind me ...` adds their own task. A teammate's name first (`Sravani: send the GMC quote by Friday`) gives one. Agents can only raise tasks to admins, as in the app.
- A **forwarded** client message, a **photo** (visiting card, client details) or a **PDF** (quote request, old policy), or text starting `lead:`, becomes a lead draft. The reply has a link to Add lead with every field filled in; nothing is saved until they press Save lead. Drafts open only for the person who made them, for 7 days (table `whatsapp_lead_drafts`). Files must be under 5 MB.
- Anything else is a question for the Task Grid copilot ("what is overdue?", "my renewals this week"). It answers from their own tasks, renewals and leads only.
- `help` lists all of this.

The AI parts (answers, new tasks, voice transcripts, lead drafts) use `OPENAI_API_KEY` and
show in Admin > AI usage. Each delivery is handled once, even when Meta
retries it (table `whatsapp_inbound`).

## 6. Clients and the old bot on the same number

Meta sends every incoming message to every app subscribed to the WhatsApp
account. An older app on the same number (for example the policy gap report
bot) answers everything, including the team.

To make the LMS the front door:
1. Add these Worker secrets:
   - `WHATSAPP_FORWARD_URL`: the older app's webhook (callback) URL, from its Meta app > WhatsApp > Configuration.
   - `WHATSAPP_FORWARD_SECRET`: that app's own App secret (its Meta app > App settings > Basic), only if it checks signatures.
2. In the **older** Meta app > WhatsApp > Configuration > Webhook fields, unsubscribe **messages**.

After that, the LMS handles the team's messages and passes everything else
(clients, delivery receipts) on to the older app, signed the way Meta signs
it, so the older app keeps working unchanged.

Without a forward URL, Admin > WhatsApp can hold a short auto-reply for
clients. It goes at most once a day per number.
