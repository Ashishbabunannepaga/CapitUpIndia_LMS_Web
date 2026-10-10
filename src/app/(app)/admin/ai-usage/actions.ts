"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { friendlyError } from "@/lib/action-errors";
import { getSession } from "@/lib/auth";
import { updateModelPricing as savePricing, updateSetting } from "@/server/data/ai";

export type PricingResult = { ok: true } | { ok: false; error: string };

const pricingSchema = z.object({
  model_name: z.string().trim().min(1).max(120),
  input_usd_per_million: z.coerce.number().min(0).max(10000),
  output_usd_per_million: z.coerce.number().min(0).max(10000),
});

const SIGNED_OUT: PricingResult = { ok: false, error: "Your session has ended. Sign in again." };

/** Admins keep Gemini pricing current; every new call is priced from it. */
export async function updateModelPricing(formData: FormData): Promise<PricingResult> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  const parsed = pricingSchema.safeParse({
    model_name: formData.get("model_name"),
    input_usd_per_million: formData.get("input_usd_per_million"),
    output_usd_per_million: formData.get("output_usd_per_million"),
  });
  if (!parsed.success) return { ok: false, error: "Enter prices in US dollars per million tokens." };

  try {
    await savePricing(session.ctx, session.actor, parsed.data);
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
  revalidatePath("/admin/ai-usage");
  return { ok: true };
}

/** The USD to INR rate used to price AI calls. */
export async function updateExchangeRate(formData: FormData): Promise<PricingResult> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  const rate = Number(formData.get("usd_to_inr"));
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) return { ok: false, error: "Enter a rate between 0 and 1000." };

  try {
    await updateSetting(session.ctx, session.actor, "usd_to_inr", rate);
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
  revalidatePath("/admin/ai-usage");
  return { ok: true };
}
