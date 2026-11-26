import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";

import { AiRateLimitError, AiUnavailableError, transcribe } from "@/lib/ai/client";
import { createDataContext } from "@/server/data/context";
import type { DataContext } from "@/server/data/context";
import {
  claimWhatsAppInbound,
  clientAutoReply,
  handleWhatsAppReply,
  whatsAppTeamMember,
  type WhatsAppHelpers,
  type WhatsAppReply,
} from "@/server/data/whatsapp";
import { copilotAnswer, copilotDrafts } from "@/server/task-copilot";
import { downloadMedia, forwardWebhook, sendText, validSignature, whatsAppConfig, type WhatsAppConfig } from "@/server/whatsapp/client";

// Meta's WhatsApp webhook. GET is the one-time check when the URL is saved in
// Meta (it must echo hub.challenge when hub.verify_token matches). POST
// carries incoming messages, signed with the app secret. Team members with
// WhatsApp on are handled by src/server/data/whatsapp.ts. Everything else
// (clients, delivery receipts) goes to the older app on the same number when
// WHATSAPP_FORWARD_URL is set, and clients get the admins' auto-reply if one
// is saved. Meta gets its 200 straight away; the work runs after it.
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
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  button?: { payload?: string; text?: string };
  interactive?: { button_reply?: { id?: string; title?: string } };
  audio?: { id?: string };
  context?: { id?: string };
};

function aiMessage(error: unknown, fallback: string): Error {
  return new Error(error instanceof AiRateLimitError || error instanceof AiUnavailableError ? error.message : fallback);
}

function helpersFor(ctx: DataContext, cfg: WhatsAppConfig): WhatsAppHelpers {
  return {
    ask: async (person, question, facts) => {
      try {
        return await copilotAnswer(ctx, person, question, facts);
      } catch (error) {
        throw aiMessage(error, "I couldn't answer that just now. Try again, or open the LMS.");
      }
    },
    drafts: async (person, request) => {
      try {
        return await copilotDrafts(ctx, person, request);
      } catch (error) {
        throw aiMessage(error, 'I couldn\'t read a task in that. Try "Sravani: send the GMC quote by Friday".');
      }
    },
    fetchAudio: (mediaId) => downloadMedia(cfg, mediaId),
    transcribe: async (person, audio) => {
      try {
        const { text } = await transcribe({
          ctx,
          user: person,
          feature: "other",
          audio: audio.bytes,
          mime: audio.mime,
          ext: audio.ext,
          durationMs: audio.ms,
          prompt: "An Indian insurance broker's team talking about tasks, clients and renewals: GMC, GPA, GTL, WC, fire, marine, motor, health, renewal, quote, KYC, PAN, policy.",
        });
        return text;
      } catch (error) {
        throw aiMessage(error, "The voice note couldn't be transcribed.");
      }
    },
  };
}

export async function POST(request: Request) {
  const { env, ctx: worker } = await getCloudflareContext({ async: true });
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
  const ctx = createDataContext(env.DB, env, env.CARDS);
  const cfg = whatsAppConfig(env);

  const work = (async () => {
    const team = await Promise.all(messages.map(async (m) => (m.from ? whatsAppTeamMember(ctx, m.from) : null)));
    // Anything that isn't only team messages (clients, delivery receipts) also goes to the older app.
    const forwarding = messages.length === 0 || team.some((p) => !p) ? await forwardWebhook(env, raw) : false;

    for (const [i, m] of messages.entries()) {
      if (!m.from) continue;
      try {
        if (m.id && !(await claimWhatsAppInbound(ctx, m.id))) continue;
        if (!team[i]) {
          // The older app answers clients when forwarding is on; otherwise the admins' auto-reply, once a day.
          const auto = forwarding ? null : await clientAutoReply(ctx, m.from);
          if (auto && cfg) await sendText(cfg, m.from, auto);
          continue;
        }
        const reply: WhatsAppReply = {
          from: m.from,
          id: m.id,
          payload: m.button?.payload ?? m.interactive?.button_reply?.id,
          text: m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title,
          contextId: m.context?.id,
          audioId: m.type === "audio" ? m.audio?.id : undefined,
        };
        if (!reply.payload && !reply.text && !reply.audioId) {
          if (cfg) await sendText(cfg, m.from, "I can read text and voice notes. Photos and files aren't supported here yet.");
          continue;
        }
        const answer = await handleWhatsAppReply(ctx, reply, cfg ? helpersFor(ctx, cfg) : {});
        if (answer && cfg) await sendText(cfg, m.from, answer);
      } catch (error) {
        console.error("WhatsApp message failed", { message: error instanceof Error ? error.message : String(error) });
      }
    }
  })().catch((error) => console.error("WhatsApp webhook failed", { message: error instanceof Error ? error.message : String(error) }));

  // Meta wants a quick 200, or it retries; AI answers can take several seconds.
  if (worker?.waitUntil) worker.waitUntil(work);
  else await work;
  return NextResponse.json({ ok: true });
}
