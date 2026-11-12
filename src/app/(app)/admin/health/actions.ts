"use server";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { friendlyError } from "@/lib/action-errors";
import { getSession } from "@/lib/auth";
import { sendTestAlert as send } from "@/server/data/monitoring";
import { alertSender, configuredChannels } from "@/server/monitoring/alerts";

export type TestAlertResult = { ok: true; message: string } | { ok: false; error: string };

/** Sends a test alert to every configured channel, so an admin can check the setup. */
export async function sendTestAlert(): Promise<TestAlertResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Your session has ended. Sign in again." };
  const { env } = await getCloudflareContext({ async: true });
  const channels = configuredChannels(env);
  if (!channels.length) return { ok: false, error: "No alert channel is set up yet. Add ALERT_NTFY_TOPIC (or another channel) as a Worker secret first." };
  try {
    await send(session.ctx, session.actor, alertSender(env));
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
  return { ok: true, message: `Sent to ${channels.join(", ")}. Check your phone.` };
}
