import "server-only";

import { GoogleGenAI, type ContentListUnion } from "@google/genai";

import type { AiFeature, Profile } from "@/lib/database.types";
import { createAdminClient } from "@/lib/supabase/admin";

// The only place the app talks to Gemini. Runs on the server with
// GEMINI_API_KEY, tries each model in order, and logs every call's real
// token usage (from usageMetadata) to ai_usage_logs; the database prices it.

/** Model fallback chains, from the existing app. Every model needs a row in ai_model_pricing. */
export const MODELS = {
  text: ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.5-pro"],
  vision: ["gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-2.5-flash"],
  writing: ["gemini-3.5-flash", "gemini-2.5-flash"],
} as const;

export class AiUnavailableError extends Error {
  constructor(message = "AI is not available right now.") {
    super(message);
    this.name = "AiUnavailableError";
  }
}

export class AiRateLimitError extends Error {
  constructor(limit: number) {
    super(`You've reached the limit of ${limit} AI requests an hour. Try again later.`);
    this.name = "AiRateLimitError";
  }
}

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  client ??= new GoogleGenAI({ apiKey, httpOptions: { timeout: 45_000 } });
  return client;
}

export function isAiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

type Caller = Pick<Profile, "id" | "full_name">;

async function enforceRateLimit(user: Caller, calls: number) {
  const admin = createAdminClient();
  const [{ data: setting }, { count }] = await Promise.all([
    admin.from("app_settings").select("value").eq("key", "ai_hourly_limit_per_user").maybeSingle(),
    admin
      .from("ai_usage_logs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("created_at", new Date(Date.now() - 3_600_000).toISOString()),
  ]);
  const limit = Number(setting?.value ?? 200);
  if (Number.isFinite(limit) && limit > 0 && (count ?? 0) + calls > limit) throw new AiRateLimitError(limit);
}

async function logUsage(user: Caller, feature: AiFeature, model: string, input: number, output: number) {
  const { error } = await createAdminClient().from("ai_usage_logs").insert({
    user_id: user.id,
    agent_name: user.full_name,
    feature_name: feature,
    model_name: model,
    input_tokens: input,
    output_tokens: output,
  });
  if (error) console.error("Could not log AI usage", { feature, model, error: error.message });
}

type GenerateOptions<T> = {
  user: Caller;
  feature: AiFeature;
  models: readonly string[];
  contents: ContentListUnion;
  systemInstruction?: string;
  temperature: number;
  /** JSON Schema for structured output; omit for plain text. */
  jsonSchema?: unknown;
  /** Parses and checks the response; throw to fall through to the next model. */
  parse: (text: string) => T;
  /** Calls this request counts as for rate limiting (bulk mapping sends several). */
  rateLimitCalls?: number;
};

/**
 * Generates with the first model that returns a usable response.
 * Throws AiUnavailableError when no key is configured or every model fails.
 */
export async function generate<T>(opts: GenerateOptions<T>): Promise<{ value: T; model: string }> {
  const ai = getClient();
  if (!ai) throw new AiUnavailableError("AI is not configured on this server (GEMINI_API_KEY is missing).");
  await enforceRateLimit(opts.user, opts.rateLimitCalls ?? 1);

  let lastError: unknown;
  for (const model of opts.models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: opts.contents,
        config: {
          systemInstruction: opts.systemInstruction,
          temperature: opts.temperature,
          ...(opts.jsonSchema ? { responseMimeType: "application/json", responseJsonSchema: opts.jsonSchema } : {}),
        },
      });
      const usage = response.usageMetadata;
      await logUsage(
        opts.user,
        opts.feature,
        model,
        (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0),
        (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      );
      const text = response.text?.trim();
      if (!text) throw new Error("Empty response");
      return { value: opts.parse(text), model };
    } catch (error) {
      lastError = error;
      console.warn(`Gemini ${model} failed for ${opts.feature}`, error instanceof Error ? error.message : error);
    }
  }
  throw new AiUnavailableError(
    lastError instanceof Error && /quota|rate/i.test(lastError.message)
      ? "The AI service is over its quota right now. Try again shortly."
      : "The AI service could not process this request.",
  );
}

/** Parses a JSON object, tolerating code fences and stray text (even text with braces) around it. */
export function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("No JSON object in response");
  let lastError: unknown = new Error("No JSON object in response");
  // Try the longest candidate first, then shorter ones ending at earlier braces.
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Response is not an object");
      return value as Record<string, unknown>;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
