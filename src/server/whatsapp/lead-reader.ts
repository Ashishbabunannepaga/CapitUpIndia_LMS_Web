import "server-only";

import { AiRateLimitError, AiUnavailableError, generate, parseJsonObject } from "@/lib/ai/client";
import { heuristicParseText } from "@/lib/ai/heuristics";
import { cleanExtractedLead } from "@/lib/ai/lead-cleanup";
import { MAX_OUTPUT_TOKENS, MODEL_CHAINS } from "@/lib/ai/models";
import { leadIntakePrompt, visitingCardPrompt } from "@/lib/ai/prompts";
import { leadSchema } from "@/lib/ai/schemas";
import { todayInBusinessTz } from "@/lib/dates";
import { sniffImage } from "@/lib/visiting-cards";

import type { Actor } from "../data/actor";
import type { DataContext } from "../data/context";
import type { LeadReading, LeadSource } from "../data/whatsapp";

// Reads a lead out of what someone sent on WhatsApp, with the same prompts
// and clean-up rules as AI Intake: forwarded text like typed notes, a photo
// like a visiting card, a PDF like notes in a file. Nothing is saved here.

const MAX_TEXT = 8000;

export async function readLeadFromWhatsApp(ctx: DataContext, person: Actor, source: LeadSource): Promise<LeadReading> {
  const today = todayInBusinessTz();
  try {
    if (source.kind === "text") {
      const text = source.text.trim().slice(0, MAX_TEXT);
      try {
        const { value } = await generate({
          ctx,
          user: person,
          feature: "lead_intake",
          models: MODEL_CHAINS.text,
          system: leadIntakePrompt(today),
          text: `Message forwarded by a sales agent (often written by the client):\n${text}`,
          jsonSchema: leadSchema,
          maxOutputTokens: MAX_OUTPUT_TOKENS.lead,
          parse: parseJsonObject,
        });
        return cleanExtractedLead(value, { sourceText: text, today });
      } catch (error) {
        if (!(error instanceof AiUnavailableError)) throw error;
        // Same offline fallback as AI Intake.
        return cleanExtractedLead(heuristicParseText(text, today), { sourceText: text, today });
      }
    }
    const base64 = Buffer.from(source.bytes).toString("base64");
    if (source.kind === "image") {
      const image = sniffImage(source.bytes);
      if (!image) throw new Error("Send the photo as a JPEG, PNG or WebP.");
      const { value } = await generate({
        ctx,
        user: person,
        feature: "card_ocr",
        models: MODEL_CHAINS.vision,
        system: visitingCardPrompt(today),
        text: "Read this visiting card or photo of client details.",
        image: { mime: image.mime, base64 },
        jsonSchema: leadSchema,
        maxOutputTokens: MAX_OUTPUT_TOKENS.lead,
        parse: parseJsonObject,
      });
      return cleanExtractedLead({ ...value, type: "New", renewal_date: "" }, { today });
    }
    if (!isPdf(source.bytes)) throw new Error("That file isn't a PDF. Send a PDF or a photo.");
    const { value } = await generate({
      ctx,
      user: person,
      feature: "lead_intake",
      models: MODEL_CHAINS.vision,
      system: leadIntakePrompt(today),
      text: "A sales agent sent this PDF from a client (a quote request, an old policy or company details). Read the lead from it.",
      file: { name: "client.pdf", mime: "application/pdf", base64 },
      jsonSchema: leadSchema,
      maxOutputTokens: MAX_OUTPUT_TOKENS.lead,
      parse: parseJsonObject,
    });
    return cleanExtractedLead(value, { today });
  } catch (error) {
    if (error instanceof AiRateLimitError || error instanceof AiUnavailableError) throw new Error(`${error.message} Use AI Intake in the LMS instead.`);
    if (error instanceof Error && /^(Send the photo|That file isn't)/.test(error.message)) throw error;
    console.error("WhatsApp lead read failed", { message: error instanceof Error ? error.message : String(error) });
    throw new Error("I couldn't read a lead in that. Try AI Intake in the LMS.");
  }
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}
