"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type PricingResult = { ok: true } | { ok: false; error: string };

const pricingSchema = z.object({
  model_name: z.string().trim().min(1).max(120),
  input_usd_per_million: z.coerce.number().min(0).max(10000),
  output_usd_per_million: z.coerce.number().min(0).max(10000),
});

/** Admins keep Gemini pricing current; the database prices every new call from it. */
export async function updateModelPricing(formData: FormData): Promise<PricingResult> {
  await requireAdmin();
  const parsed = pricingSchema.safeParse({
    model_name: formData.get("model_name"),
    input_usd_per_million: formData.get("input_usd_per_million"),
    output_usd_per_million: formData.get("output_usd_per_million"),
  });
  if (!parsed.success) return { ok: false, error: "Enter prices in US dollars per million tokens." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("ai_model_pricing")
    .update({
      input_usd_per_million: parsed.data.input_usd_per_million,
      output_usd_per_million: parsed.data.output_usd_per_million,
    })
    .eq("model_name", parsed.data.model_name)
    .select("model_name")
    .single();
  if (error) return { ok: false, error: "Could not save that price." };
  revalidatePath("/admin/ai-usage");
  return { ok: true };
}

/** The USD to INR rate used to price AI calls. */
export async function updateExchangeRate(formData: FormData): Promise<PricingResult> {
  await requireAdmin();
  const rate = Number(formData.get("usd_to_inr"));
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) return { ok: false, error: "Enter a rate between 0 and 1000." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("app_settings")
    .update({ value: rate })
    .eq("key", "usd_to_inr")
    .select("key")
    .single();
  if (error) return { ok: false, error: "Could not save the exchange rate." };
  revalidatePath("/admin/ai-usage");
  return { ok: true };
}
