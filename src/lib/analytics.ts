import "server-only";

import type { LeadStatus, PolicyProduct } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

// Shapes of the two analytics functions in the AI/automation migration. They
// are SECURITY INVOKER, so an agent's numbers cover only their own leads.

export type AgentPipeline = {
  agent_id: string | null;
  agent_name: string;
  total: number;
  prospect: number;
  quoted: number;
  active_client: number;
  follow_up: number;
  won: number;
  lost: number;
  overdue_renewals: number;
  renewals_30d: number;
};

export type PipelineAnalytics = {
  today: string;
  total: number;
  duplicates: number;
  unassigned: number;
  by_status: Partial<Record<LeadStatus, number>>;
  by_product: Partial<Record<PolicyProduct, number>>;
  by_type: Record<string, number>;
  by_business: Record<string, number>;
  renewals: { overdue: number; today: number; week: number; month: number; upcoming: number };
  renewals_by_month: { month: string; count: number }[];
  created_by_month: { month: string; count: number }[];
  agents: AgentPipeline[];
};

export type AiUsageBucket = {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_inr: number;
};

export type AiUsageSummary = AiUsageBucket & {
  by_agent: (AiUsageBucket & { user_id: string | null; agent_name: string })[];
  by_feature: (AiUsageBucket & { feature_name: string })[];
  by_model: (AiUsageBucket & { model_name: string })[];
  by_day: { day: string; calls: number; cost_inr: number }[];
};

export async function getPipelineAnalytics(): Promise<PipelineAnalytics> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("pipeline_analytics");
  if (error) throw error;
  return data as unknown as PipelineAnalytics;
}

export async function getAiUsageSummary(from: Date): Promise<AiUsageSummary> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("ai_usage_summary", { p_from: from.toISOString() });
  if (error) throw error;
  return data as unknown as AiUsageSummary;
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
