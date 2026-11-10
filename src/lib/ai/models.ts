// The one place that says which AI models the app uses and what they cost
// by default. Admins can change the prices on AI Usage (stored in
// ai_model_pricing); these defaults fill in any model that has no row yet.
//
// Every call tries its chain in order and stops at the first usable answer.
// "reasoningEffort: none" makes the GPT-5.6 models answer straight away,
// which is what keeps intake, follow-ups and mapping fast. Card reading gets
// a little reasoning because photos of cards are messy.

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export type ModelChoice = {
  model: string;
  reasoningEffort: ReasoningEffort;
};

export type ModelTask = "text" | "vision" | "writing";

export const MODEL_CHAINS: Record<ModelTask, readonly ModelChoice[]> = {
  /** Lead intake and spreadsheet mapping: structured JSON from text. */
  text: [
    { model: "gpt-5.6-luna", reasoningEffort: "none" },
    { model: "gpt-5.6-terra", reasoningEffort: "none" },
  ],
  /** Visiting card OCR: structured JSON from a photo. */
  vision: [
    { model: "gpt-5.6-luna", reasoningEffort: "low" },
    { model: "gpt-5.6-terra", reasoningEffort: "low" },
  ],
  /** Follow-up messages: a few sentences of plain text. */
  writing: [
    { model: "gpt-5.6-luna", reasoningEffort: "none" },
    { model: "gpt-5.6-terra", reasoningEffort: "none" },
  ],
};

/**
 * Default prices in US dollars per million tokens, from OpenAI's pricing page
 * (developers.openai.com/api/docs/pricing, checked 10 Nov 2026). Cached input
 * is cheaper on OpenAI's side; the app prices every input token at the full
 * rate, so the rupee figures err slightly high.
 */
export const DEFAULT_MODEL_PRICING: readonly {
  model_name: string;
  display_name: string;
  input_usd_per_million: number;
  output_usd_per_million: number;
}[] = [
  { model_name: "gpt-5.6-luna", display_name: "GPT-5.6 Luna (OpenAI)", input_usd_per_million: 0.2, output_usd_per_million: 1.2 },
  { model_name: "gpt-5.6-terra", display_name: "GPT-5.6 Terra (OpenAI)", input_usd_per_million: 2, output_usd_per_million: 12 },
];

/** Longest the app waits for one model before trying the next one. */
export const MODEL_TIMEOUT_MS = 25_000;

/** Upper bounds on the answer length, so a confused model can't run on. */
export const MAX_OUTPUT_TOKENS = {
  lead: 1_200,
  bulk: 6_000,
  followUp: 300,
} as const;
