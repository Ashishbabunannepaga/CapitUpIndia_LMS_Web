"use server";

import { heuristicParseText } from "@/lib/ai/heuristics";
import { AiRateLimitError, AiUnavailableError, generate, MODELS, parseJsonObject } from "@/lib/ai/gemini";
import { cleanExtractedLead, type ExtractedLead } from "@/lib/ai/lead-cleanup";
import { leadIntakePrompt, visitingCardPrompt } from "@/lib/ai/prompts";
import { leadSchema } from "@/lib/ai/schemas";
import { getSession } from "@/lib/auth";
import { todayInBusinessTz } from "@/lib/dates";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/upload-limits";
import { sniffImage } from "@/lib/visiting-cards";
import { uploadCard } from "@/server/data/cards";

export type ExtractionResult =
  | {
      ok: true;
      lead: ExtractedLead;
      /** Values removed by the clean-up rules, shown to the user. */
      dropped: string[];
      /** "ai" when Gemini extracted it, "basic" for the offline fallback. */
      source: "ai" | "basic";
      notice?: string;
      cardPath?: string;
    }
  | { ok: false; error: string };

const MAX_TEXT = 8000;
const SIGNED_OUT = { ok: false, error: "Your session has ended. Sign in again." } as const;

/** AI lead intake from typed or dictated notes. Nothing is saved; the result pre-fills the lead form. */
export async function extractLeadFromText(input: string): Promise<ExtractionResult> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  const { ctx, actor: profile } = session;
  const text = String(input ?? "").trim();
  if (!text) return { ok: false, error: "Type or dictate some notes first." };
  if (text.length > MAX_TEXT) return { ok: false, error: `Keep notes under ${MAX_TEXT} characters.` };
  const today = todayInBusinessTz();

  try {
    const { value } = await generate({
      ctx,
      user: profile,
      feature: "lead_intake",
      models: MODELS.text,
      systemInstruction: leadIntakePrompt(today),
      contents: `Sales agent's note:\n${text}`,
      temperature: 0.1,
      jsonSchema: leadSchema,
      parse: parseJsonObject,
    });
    const { lead, dropped } = cleanExtractedLead(value, { sourceText: text, today });
    return { ok: true, lead, dropped, source: "ai" };
  } catch (error) {
    if (error instanceof AiRateLimitError) return { ok: false, error: error.message };
    if (!(error instanceof AiUnavailableError)) throw error;
    const { lead, dropped } = cleanExtractedLead(heuristicParseText(text, today), { sourceText: text, today });
    return {
      ok: true,
      lead,
      dropped,
      source: "basic",
      notice: `${error.message} Basic extraction filled what it could; check every field.`,
    };
  }
}

/** Visiting card OCR. Stores the image privately and returns the fields for review. */
export async function scanVisitingCard(formData: FormData): Promise<ExtractionResult> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  const { ctx, actor: profile } = session;
  const file = formData.get("card");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a photo of the card." };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: `The photo is larger than ${MAX_UPLOAD_LABEL}.` };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const image = sniffImage(bytes);
  if (!image) return { ok: false, error: "Use a JPEG, PNG or WebP photo." };
  const today = todayInBusinessTz();

  let cardPath: string | undefined;
  let notice: string | undefined;
  try {
    cardPath = await uploadCard(ctx, profile, bytes);
  } catch (error) {
    console.error("Visiting card upload failed", error);
    notice = "The card photo could not be stored, so it won't be attached to the lead.";
  }

  try {
    const { value } = await generate({
      ctx,
      user: profile,
      feature: "card_ocr",
      models: MODELS.vision,
      contents: [
        {
          role: "user",
          parts: [
            { text: visitingCardPrompt(today) },
            { inlineData: { mimeType: image.mime, data: Buffer.from(bytes).toString("base64") } },
          ],
        },
      ],
      temperature: 0.2,
      jsonSchema: leadSchema,
      parse: parseJsonObject,
    });
    // No source text to cross-check against, so only placeholder values are dropped.
    const { lead, dropped } = cleanExtractedLead({ ...value, type: "New", renewal_date: "" }, { today });
    return { ok: true, lead, dropped, source: "ai", cardPath, notice };
  } catch (error) {
    if (error instanceof AiUnavailableError || error instanceof AiRateLimitError) {
      return { ok: false, error: `${error.message} You can still type the card's details into the lead form.` };
    }
    throw error;
  }
}
