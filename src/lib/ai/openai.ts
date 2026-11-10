import "server-only";

import type { ModelChoice } from "./models";

// The OpenAI provider: one Chat Completions request over plain fetch (no SDK,
// which keeps the Worker bundle small). Only src/lib/ai/client.ts calls it.

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

export type ProviderRequest = {
  choice: ModelChoice;
  system?: string;
  text: string;
  image?: { mime: string; base64: string };
  /** JSON Schema for strict structured output; omit for plain text. */
  jsonSchema?: { name: string; schema: unknown };
  maxOutputTokens: number;
  timeoutMs: number;
};

export type ProviderResponse = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Set when the model answered but the answer can't be used (refused, cut off). Tokens are still billed. */
  problem?: string;
};

/** A failure that no other model can fix (bad key, no credit), so the fallback chain stops. */
export class ProviderFatalError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "quota",
  ) {
    super(message);
    this.name = "ProviderFatalError";
  }
}

export function openAiKey(): string | undefined {
  return process.env.OPENAI_API_KEY?.trim() || undefined;
}

type ChatCompletion = {
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string; type?: string };
};

export async function callOpenAi(apiKey: string, req: ProviderRequest): Promise<ProviderResponse> {
  const userContent = req.image
    ? [
        { type: "text", text: req.text },
        { type: "image_url", image_url: { url: `data:${req.image.mime};base64,${req.image.base64}`, detail: "high" } },
      ]
    : req.text;

  const body = {
    model: req.choice.model,
    messages: [...(req.system ? [{ role: "developer", content: req.system }] : []), { role: "user", content: userContent }],
    reasoning_effort: req.choice.reasoningEffort,
    max_completion_tokens: req.maxOutputTokens,
    store: false,
    ...(req.jsonSchema
      ? { response_format: { type: "json_schema", json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema } } }
      : {}),
  };

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(req.timeoutMs),
  });
  const data = (await response.json().catch(() => ({}))) as ChatCompletion;

  if (!response.ok) {
    const detail = data.error?.message ?? `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      // 401: wrong or revoked key. 403: the key's project can't use this API or region.
      throw new ProviderFatalError(`OpenAI refused the request (${response.status}): ${detail}`, "auth");
    }
    if (response.status === 429 && data.error?.code === "insufficient_quota") {
      throw new ProviderFatalError(`OpenAI account is out of credit: ${detail}`, "quota");
    }
    throw new Error(`OpenAI ${response.status}: ${detail}`);
  }

  const choice = data.choices?.[0];
  return {
    text: choice?.message?.content?.trim() ?? "",
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    problem: choice?.message?.refusal
      ? "The model refused the request"
      : choice?.finish_reason === "length"
        ? "The answer was cut off"
        : undefined,
  };
}
