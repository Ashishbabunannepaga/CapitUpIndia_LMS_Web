"use server";

import { AiRateLimitError, AiUnavailableError, generate, MODELS } from "@/lib/ai/gemini";
import { followUpPrompt, isFollowUpTone, rephrasePrompt, type FollowUpTone } from "@/lib/ai/prompts";
import { requireProfile } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { createClient } from "@/lib/supabase/server";

export type FollowUpResult =
  | { ok: true; text: string; source: "ai" | "template"; notice?: string }
  | { ok: false; error: string };

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** Used when AI is unavailable, so the agent still gets a sendable draft. */
function templateDraft(tone: FollowUpTone, poc: string, client: string, product: string, sender: string): string {
  const hello = poc ? `Hi ${firstName(poc)},` : "Hello,";
  const body: Record<FollowUpTone, string> = {
    professional: `Just checking in on the ${product.toLowerCase()} insurance proposal for ${client}. Could we find a few minutes this week to take it forward?`,
    warm: `Hope you're doing well. I wanted to follow up on the ${product.toLowerCase()} insurance plan for ${client} and see if any questions came up.`,
    concise: `Following up on ${client}'s ${product.toLowerCase()} insurance. Free for a quick call today?`,
    benefit: `A quick review of ${client}'s ${product.toLowerCase()} cover could help you renew on better terms. Shall we go through the options this week?`,
  };
  return `${hello}\n\n${body[tone]}\n\nRegards, ${sender}`;
}

/**
 * Writes (or rewrites) a short follow-up for a lead. The lead is read as the
 * signed-in user, so RLS decides whether they may see it.
 */
export async function generateFollowUp(leadId: number, tone: string, previousDraft?: string): Promise<FollowUpResult> {
  const profile = await requireProfile();
  if (!isFollowUpTone(tone)) return { ok: false, error: "Pick a tone." };

  const supabase = await createClient();
  const { data: lead } = await supabase.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!lead) return { ok: false, error: "That lead no longer exists or isn't yours." };
  const { data: notes } = await supabase
    .from("lead_notes")
    .select("agent_name, content, created_at")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(5);

  const sender = firstName(profile.full_name) || profile.full_name;
  const context = [
    `Company: ${lead.client_name}`,
    `Contact: ${lead.poc_name || "unknown"}${lead.poc_designation && lead.poc_designation !== "poc" ? ` (${lead.poc_designation})` : ""}`,
    `Product: ${lead.policy_product}${lead.sub_product_name ? ` - ${lead.sub_product_name}` : ""} (${lead.type}, ${lead.business_type})`,
    `Pipeline status: ${lead.status}`,
    lead.renewal_date ? `Renewal date: ${formatDate(lead.renewal_date)}` : "",
    lead.notes ? `Lead notes: ${lead.notes.slice(0, 1500)}` : "",
    notes?.length ? `Recent updates (newest first):\n${notes.map((n) => `- ${n.content.slice(0, 300)}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const rephrase = Boolean(previousDraft?.trim());
  try {
    const { value } = await generate({
      user: profile,
      feature: rephrase ? "follow_up_rephrase" : "follow_up",
      models: MODELS.writing,
      systemInstruction: rephrase ? rephrasePrompt(tone, sender) : followUpPrompt(tone, sender),
      contents: rephrase
        ? `${context}\n\nPrevious draft:\n"""${previousDraft!.slice(0, 1500)}"""\n\nWrite the new version.`
        : `${context}\n\nWrite the message.`,
      temperature: rephrase ? 0.85 : 0.6,
      parse: (text) => {
        const clean = text.replace(/^["']|["']$/g, "").trim();
        if (/\[(your|company|client|name)[^\]]*\]/i.test(clean)) throw new Error("Draft contains placeholders");
        return clean;
      },
    });
    return { ok: true, text: value, source: "ai" };
  } catch (error) {
    if (error instanceof AiRateLimitError) return { ok: false, error: error.message };
    if (!(error instanceof AiUnavailableError)) throw error;
    return {
      ok: true,
      text: templateDraft(tone, lead.poc_name, lead.client_name, lead.policy_product, sender),
      source: "template",
      notice: `${error.message} Here is a standard draft instead.`,
    };
  }
}
