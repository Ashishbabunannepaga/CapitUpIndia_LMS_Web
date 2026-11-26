import "server-only";

// WhatsApp Cloud API (Meta), for task alerts to the team. Secrets, set by
// the owner in Cloudflare (docs/whatsapp.md):
//   WHATSAPP_TOKEN            system-user access token
//   WHATSAPP_PHONE_NUMBER_ID  the sending number's id
//   WHATSAPP_BUSINESS_ID      the WhatsApp Business Account id (for reference)
//   WHATSAPP_APP_SECRET       signs incoming webhooks (X-Hub-Signature-256)
//   WHATSAPP_VERIFY_TOKEN     any long random text, typed again in Meta's webhook setup
// Optional, for the older app on the same number (docs/whatsapp.md, "Clients and the old bot"):
//   WHATSAPP_FORWARD_URL      that app's webhook address; messages from non-team numbers go there
//   WHATSAPP_FORWARD_SECRET   that app's own app secret, to sign what is forwarded (if it checks signatures)
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
  WHATSAPP_FORWARD_URL?: string;
  WHATSAPP_FORWARD_SECRET?: string;
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

/** Whether clients' messages are passed on to the older app (optional; names only). */
export function whatsAppForwardStatus(env: WhatsAppEnv) {
  return { WHATSAPP_FORWARD_URL: !!env.WHATSAPP_FORWARD_URL?.trim(), WHATSAPP_FORWARD_SECRET: !!env.WHATSAPP_FORWARD_SECRET?.trim() };
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
 * The approved template: body "Update: {{1}}" / "Details: {{2}}" (see docs/whatsapp.md) with two quick-reply buttons,
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

/** A plain reply, allowed within 24 hours of the person writing to us. WhatsApp caps text at 4,096 characters. */
export function sendText(cfg: WhatsAppConfig, to: string, text: string): Promise<WhatsAppResult> {
  return post(cfg, { messaging_product: "whatsapp", to, type: "text", text: { body: text.slice(0, 3800) } });
}

/** Largest voice note we fetch (about 3 minutes of WhatsApp audio, with room to spare). */
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;

/** Downloads a media file someone sent (voice note): look up its address, then fetch it with the token. */
export async function downloadMedia(cfg: WhatsAppConfig, mediaId: string): Promise<Uint8Array> {
  if (!/^\d{1,30}$/.test(mediaId)) throw new Error("Bad media id");
  const auth = { authorization: `Bearer ${cfg.token}` };
  const meta = await fetch(`${GRAPH}/${mediaId}`, { headers: auth });
  const info = (await meta.json().catch(() => ({}))) as { url?: string; file_size?: number };
  if (!meta.ok || !info.url) throw new Error(`Media lookup failed (${meta.status})`);
  if ((info.file_size ?? 0) > MEDIA_MAX_BYTES) throw new Error("Media too large");
  // The address is Meta's own CDN; never follow one pointing anywhere else.
  const host = new URL(info.url).hostname;
  if (!/(^|\.)(fbsbx\.com|fbcdn\.net|facebook\.com|whatsapp\.net)$/.test(host)) throw new Error("Unexpected media host");
  const file = await fetch(info.url, { headers: auth });
  if (!file.ok) throw new Error(`Media download failed (${file.status})`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MEDIA_MAX_BYTES) throw new Error("Media too large");
  return bytes;
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Passes a webhook delivery on to the older app on the same number, signed
 * with that app's own secret the way Meta signs it, so it works unchanged.
 */
export async function forwardWebhook(env: WhatsAppEnv, rawBody: string): Promise<boolean> {
  const url = env.WHATSAPP_FORWARD_URL?.trim();
  const secret = env.WHATSAPP_FORWARD_SECRET?.trim();
  if (!url || !url.startsWith("https://")) return false;
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (secret) headers["x-hub-signature-256"] = `sha256=${await hmacHex(secret, rawBody)}`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: rawBody,
    });
    if (!res.ok) console.error("WhatsApp forward failed", { status: res.status });
    return res.ok;
  } catch (error) {
    console.error("WhatsApp forward failed", { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** Checks Meta's X-Hub-Signature-256 header against the raw body. */
export async function validSignature(appSecret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  const expected = await hmacHex(appSecret, rawBody);
  const given = header.slice(7).toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
