import "server-only";

// WhatsApp Cloud API (Meta), for task alerts to the team. Secrets, set by
// the owner in Cloudflare (docs/whatsapp.md):
//   WHATSAPP_TOKEN            system-user access token
//   WHATSAPP_PHONE_NUMBER_ID  the sending number's id
//   WHATSAPP_BUSINESS_ID      the WhatsApp Business Account id (for reference)
//   WHATSAPP_APP_SECRET       signs incoming webhooks (X-Hub-Signature-256)
//   WHATSAPP_VERIFY_TOKEN     any long random text, typed again in Meta's webhook setup
// Optional vars: WHATSAPP_TEMPLATE (default "lms_task_alert"), WHATSAPP_TEMPLATE_LANG (default "en").

const GRAPH = "https://graph.facebook.com/v21.0";

export type WhatsAppEnv = {
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_BUSINESS_ID?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_TEMPLATE?: string;
  WHATSAPP_TEMPLATE_LANG?: string;
};

export type WhatsAppConfig = { token: string; phoneNumberId: string; template: string; lang: string };

/** Which secrets are set (names only, never values), for Admin > WhatsApp. */
export function whatsAppStatus(env: WhatsAppEnv) {
  const has = (v?: string) => !!v?.trim();
  return {
    WHATSAPP_TOKEN: has(env.WHATSAPP_TOKEN),
    WHATSAPP_PHONE_NUMBER_ID: has(env.WHATSAPP_PHONE_NUMBER_ID),
    WHATSAPP_BUSINESS_ID: has(env.WHATSAPP_BUSINESS_ID),
    WHATSAPP_APP_SECRET: has(env.WHATSAPP_APP_SECRET),
    WHATSAPP_VERIFY_TOKEN: has(env.WHATSAPP_VERIFY_TOKEN),
  };
}

export function whatsAppConfig(env: WhatsAppEnv): WhatsAppConfig | null {
  const token = env.WHATSAPP_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneNumberId) return null;
  return { token, phoneNumberId, template: env.WHATSAPP_TEMPLATE?.trim() || "lms_task_alert", lang: env.WHATSAPP_TEMPLATE_LANG?.trim() || "en" };
}

export type WhatsAppAlert = { to: string; title: string; body: string; taskId: number };
export type WhatsAppResult = { ok: true; id: string } | { ok: false; error: string };
/** Sends one alert; the cron uses sendTaskAlert, tests pass a fake. */
export type WhatsAppSender = (alert: WhatsAppAlert) => Promise<WhatsAppResult>;

/** Template parameters can't hold new lines, tabs or 4+ spaces, and are capped. */
function param(text: string, max: number): string {
  const clean = text.replace(/[\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim();
  return (clean || "-").slice(0, max);
}

async function post(cfg: WhatsAppConfig, payload: unknown): Promise<WhatsAppResult> {
  try {
    const res = await fetch(`${GRAPH}/${cfg.phoneNumberId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number } };
    if (!res.ok || !data.messages?.[0]?.id) return { ok: false, error: `${res.status} ${data.error?.code ?? ""} ${data.error?.message ?? "send failed"}`.trim() };
    return { ok: true, id: data.messages[0].id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The approved template: body "{{1}}" / "{{2}}" with two quick-reply buttons,
 * Done and Snooze 1h, whose payloads carry the task id back to the webhook.
 */
export function taskAlertSender(cfg: WhatsAppConfig): WhatsAppSender {
  return (alert) =>
    post(cfg, {
      messaging_product: "whatsapp",
      to: alert.to,
      type: "template",
      template: {
        name: cfg.template,
        language: { code: cfg.lang },
        components: [
          { type: "body", parameters: [{ type: "text", text: param(alert.title, 300) }, { type: "text", text: param(alert.body, 600) }] },
          { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `done:${alert.taskId}` }] },
          { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `snooze:${alert.taskId}` }] },
        ],
      },
    });
}

/** A plain reply, allowed within 24 hours of the person writing to us. */
export function sendText(cfg: WhatsAppConfig, to: string, text: string): Promise<WhatsAppResult> {
  return post(cfg, { messaging_product: "whatsapp", to, type: "text", text: { body: text.slice(0, 1000) } });
}

/** Checks Meta's X-Hub-Signature-256 header against the raw body. */
export async function validSignature(appSecret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7).toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
