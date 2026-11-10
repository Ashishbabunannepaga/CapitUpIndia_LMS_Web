import "server-only";

import { after } from "next/server";

import type { AiFeature, Profile } from "@/lib/database.types";
import { aiCallsThisHour, logAiUsage } from "@/server/data/ai";
import type { DataContext } from "@/server/data/context";

import { MODEL_TIMEOUT_MS, type ModelChoice } from "./models";
import { callOpenAi, openAiKey, ProviderFatalError } from "./openai";

// The only door to the AI provider. Features (intake, card OCR, follow-ups,
// import mapping) call generate() and never see which provider answers.
// It runs on the server with the OPENAI_API_KEY Worker secret, tries each
// model in order, and logs every call's real token usage to ai_usage_logs,
// priced from the central pricing table. Logging runs after the response is
// sent, so it never slows the user down.

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

export function isAiConfigured(): boolean {
  return Boolean(openAiKey());
}

type Caller = Pick<Profile, "id" | "full_name">;

async function enforceRateLimit(ctx: DataContext, user: Caller, calls: number) {
  const { used, limit } = await aiCallsThisHour(ctx, user.id);
  if (Number.isFinite(limit) && limit > 0 && used + calls > limit) throw new AiRateLimitError(limit);
}

async function logUsage(ctx: DataContext, user: Caller, feature: AiFeature, model: string, input: number, output: number) {
  try {
    await logAiUsage(ctx, user, { feature, model, inputTokens: input, outputTokens: output });
  } catch (error) {
    console.error("Could not log AI usage", { feature, model, error: error instanceof Error ? error.message : error });
  }
}

/** Runs the log after the response when inside a request; awaits it otherwise (tests, scripts). */
async function logLater(task: () => Promise<void>) {
  try {
    after(task);
  } catch {
    await task();
  }
}

type GenerateOptions<T> = {
  /** The request's data context (src/server/data), for rate limits and usage logs. */
  ctx: DataContext;
  user: Caller;
  feature: AiFeature;
  /** Models to try in order, from MODEL_CHAINS in src/lib/ai/models.ts. */
  models: readonly ModelChoice[];
  /** Standing instructions (the prompt). */
  system?: string;
  /** The user's material: notes, sheet rows, lead context. */
  text: string;
  /** An image to read (visiting cards). */
  image?: { mime: string; base64: string };
  /** JSON Schema for strict structured output; omit for plain text. */
  jsonSchema?: { name: string; schema: unknown };
  maxOutputTokens: number;
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
  const apiKey = openAiKey();
  if (!apiKey) throw new AiUnavailableError("AI is not configured on this server (OPENAI_API_KEY is missing).");
  await enforceRateLimit(opts.ctx, opts.user, opts.rateLimitCalls ?? 1);

  let lastError: unknown;
  for (const choice of opts.models) {
    try {
      const response = await callOpenAi(apiKey, {
        choice,
        system: opts.system,
        text: opts.text,
        image: opts.image,
        jsonSchema: opts.jsonSchema,
        maxOutputTokens: opts.maxOutputTokens,
        timeoutMs: MODEL_TIMEOUT_MS,
      });
      await logLater(() => logUsage(opts.ctx, opts.user, opts.feature, choice.model, response.inputTokens, response.outputTokens));
      if (response.problem) throw new Error(response.problem);
      if (!response.text) throw new Error("Empty response");
      return { value: opts.parse(response.text), model: choice.model };
    } catch (error) {
      lastError = error;
      console.warn(`AI model ${choice.model} failed for ${opts.feature}`, error instanceof Error ? error.message : error);
      // A bad key or an empty account fails the same way on every model.
      if (error instanceof ProviderFatalError) break;
    }
  }
  throw new AiUnavailableError(
    lastError instanceof ProviderFatalError
      ? lastError.kind === "quota"
        ? "The OpenAI account is out of credit. An admin needs to add credit on platform.openai.com."
        : "The OpenAI key was refused. An admin needs to check the OPENAI_API_KEY secret."
      : lastError instanceof Error && /\b429\b|rate/i.test(lastError.message)
        ? "The AI service is busy right now. Try again shortly."
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
