# WhatsApp task alerts

Task Grid alerts can also go to each person's WhatsApp, through the Meta
WhatsApp Cloud API. Each alert has **Done** and **Snooze 1h** buttons, and
pressing one updates the task in the LMS as that person.

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
  CapitUp LMS: {{1}}

  {{2}}
  ```
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
