"use server";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { friendlyError } from "@/lib/action-errors";
import { getSession } from "@/lib/auth";
import { InvalidInputError } from "@/server/data/errors";
import { sendWhatsAppTest, setWhatsApp } from "@/server/data/whatsapp";
import { taskAlertSender, whatsAppConfig } from "@/server/whatsapp/client";

const PAGE = "/admin/whatsapp";

async function run(fn: (s: NonNullable<Awaited<ReturnType<typeof getSession>>>) => Promise<void>, ok?: string): Promise<void> {
  const session = await getSession();
  if (!session) redirect("/login");
  let error: string | null = null;
  try {
    await fn(session);
  } catch (e) {
    error = friendlyError(e);
  }
  revalidatePath(PAGE);
  redirect(error ? `${PAGE}?error=${encodeURIComponent(error)}` : ok ? `${PAGE}?ok=${encodeURIComponent(ok)}` : PAGE);
}

export async function saveWhatsAppAction(formData: FormData): Promise<void> {
  await run((s) =>
    setWhatsApp(s.ctx, s.actor, String(formData.get("user_id") ?? ""), String(formData.get("phone") ?? ""), formData.get("on") === "on"),
  );
}

export async function testWhatsAppAction(formData: FormData): Promise<void> {
  await run(async (s) => {
    const { env } = await getCloudflareContext({ async: true });
    const cfg = whatsAppConfig(env);
    if (!cfg) throw new InvalidInputError("WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID aren't set on the Worker yet.");
    await sendWhatsAppTest(s.ctx, s.actor, String(formData.get("user_id") ?? ""), taskAlertSender(cfg));
  }, "Test sent. Check that phone.");
}
