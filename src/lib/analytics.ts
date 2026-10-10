import "server-only";

import { requireSession } from "@/lib/auth";
import { aiUsageSummary, type AiUsageSummary } from "@/server/data/ai";
import { pipelineAnalytics, type AgentPipeline, type PipelineAnalytics } from "@/server/data/analytics";

// An agent's numbers cover only their own leads and usage.

export type { AgentPipeline, AiUsageSummary, PipelineAnalytics };

export async function getPipelineAnalytics(): Promise<PipelineAnalytics> {
  const { ctx, actor } = await requireSession();
  return pipelineAnalytics(ctx, actor);
}

export async function getAiUsageSummary(from: Date): Promise<AiUsageSummary> {
  const { ctx, actor } = await requireSession();
  return aiUsageSummary(ctx, actor, from);
}

/** "₹1,234.56" */
export function formatInr(value: number, fractionDigits = 2): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(value);
}

/** "1 call" / "4 calls" */
export function plural(count: number, word: string): string {
  return `${formatCount(count)} ${word}${count === 1 ? "" : "s"}`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-IN").format(value);
}

export const AI_FEATURE_LABELS: Record<string, string> = {
  lead_intake: "AI lead intake",
  card_ocr: "Visiting card OCR",
  follow_up: "Follow-up writer",
  follow_up_rephrase: "Follow-up rephrase",
  bulk_mapping: "Bulk import mapping",
  other: "Other",
};
