import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";

import { createDataContext } from "@/server/data/context";
import { handleWhatsAppReply, type WhatsAppReply } from "@/server/data/whatsapp";
import { sendText, validSignature, whatsAppConfig } from "@/server/whatsapp/client";

// Meta's WhatsApp webhook. GET is the one-time check when the URL is saved in
// Meta (it must echo hub.challenge when hub.verify_token matches). POST
// carries incoming messages, signed with the app secret; only Done / Snooze
// replies from team members with WhatsApp on do anything (see
// src/server/data/whatsapp.ts). Anything unsigned or unknown is ignored.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { env } = await getCloudflareContext({ async: true });
  const url = new URL(request.url);
  const expected = env.WHATSAPP_VERIFY_TOKEN?.trim();
  if (url.searchParams.get("hub.mode") === "subscribe" && expected && url.searchParams.get("hub.verify_token") === expected) {
    return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
}

type Incoming = {
  from?: string;
  type?: string;
  text?: { body?: string };
  button?: { payload?: string; text?: string };
  interactive?: { button_reply?: { id?: string; title?: string } };
  context?: { id?: string };
};

export async function POST(request: Request) {
  const { env } = await getCloudflareContext({ async: true });
  const raw = await request.text();
  if (raw.length > 200_000 || !(await validSignature(env.WHATSAPP_APP_SECRET?.trim() ?? "", raw, request.headers.get("x-hub-signature-256")))) {
    return new Response("Forbidden", { status: 403 });
  }
  let body: { entry?: { changes?: { value?: { messages?: Incoming[] } }[] }[] };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }
  const messages = (body.entry ?? []).flatMap((e) => (e.changes ?? []).flatMap((c) => c.value?.messages ?? [])).slice(0, 20);
  if (messages.length === 0) return NextResponse.json({ ok: true });

  const ctx = createDataContext(env.DB, env, env.CARDS);
  const cfg = whatsAppConfig(env);
  for (const m of messages) {
    if (!m.from) continue;
    const reply: WhatsAppReply = {
      from: m.from,
      payload: m.button?.payload ?? m.interactive?.button_reply?.id,
      text: m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title,
      contextId: m.context?.id,
    };
    try {
      const answer = await handleWhatsAppReply(ctx, reply);
      if (answer && cfg) await sendText(cfg, m.from, answer);
    } catch (error) {
      console.error("WhatsApp reply failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }
  // Always 200, or Meta keeps retrying the same message.
  return NextResponse.json({ ok: true });
}
