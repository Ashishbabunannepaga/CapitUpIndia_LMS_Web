import "server-only";

import { and, asc, count, eq, gte, lt } from "drizzle-orm";

import { businessDateOf } from "@/lib/dates";

import { aiModelPricing, aiUsageLogs, appSettings, AI_FEATURES } from "../db/schema";
import { assertAdmin, isAdmin, type Actor } from "./actor";
import { auditInsert } from "./audit";
import type { DataContext } from "./context";
import { InvalidInputError } from "./errors";

// Gemini usage and its cost, priced centrally: admins keep model prices and
// the USD to INR rate; each call is priced when it is logged. Agents see only
// their own usage.

export type AiFeature = (typeof AI_FEATURES)[number];
export type ModelPricing = typeof aiModelPricing.$inferSelect;

async function setting<T>(ctx: DataContext, key: string, fallback: T): Promise<T> {
  const row = await ctx.db.query.appSettings.findFirst({ where: eq(appSettings.key, key) });
  return (row?.value as T | undefined) ?? fallback;
}

/** Calls this user made to Gemini in the last hour, and their hourly allowance. */
export async function aiCallsThisHour(ctx: DataContext, userId: string) {
  const [limit, [row]] = await Promise.all([
    setting<number>(ctx, "ai_hourly_limit_per_user", 200),
    ctx.db
      .select({ n: count() })
      .from(aiUsageLogs)
      .where(and(eq(aiUsageLogs.user_id, userId), gte(aiUsageLogs.created_at, new Date(Date.now() - 3_600_000).toISOString()))),
  ]);
  return { used: row?.n ?? 0, limit: Number(limit) };
}

/** Records one Gemini call, priced in INR from the central pricing. */
export async function logAiUsage(
  ctx: DataContext,
  user: Pick<Actor, "id" | "full_name">,
  call: { feature: AiFeature; model: string; inputTokens: number; outputTokens: number },
): Promise<void> {
  const [pricing, fx] = await Promise.all([
    ctx.db.query.aiModelPricing.findFirst({ where: eq(aiModelPricing.model_name, call.model) }),
    setting<number>(ctx, "usd_to_inr", 0),
  ]);
  if (!pricing) throw new InvalidInputError(`No pricing configured for model ${call.model}`);
  const input = Math.max(0, Math.round(call.inputTokens));
  const output = Math.max(0, Math.round(call.outputTokens));
  const usd = (input * pricing.input_usd_per_million + output * pricing.output_usd_per_million) / 1_000_000;
  await ctx.db.insert(aiUsageLogs).values({
    user_id: user.id,
    agent_name: user.full_name || "System",
    feature_name: AI_FEATURES.includes(call.feature) ? call.feature : "other",
    model_name: call.model,
    input_tokens: input,
    output_tokens: output,
    cost_inr: Math.round(usd * Number(fx) * 10_000) / 10_000,
  });
}

export async function listModelPricing(ctx: DataContext, actor: Actor): Promise<ModelPricing[]> {
  void actor;
  return ctx.db.select().from(aiModelPricing).orderBy(asc(aiModelPricing.model_name));
}

export async function getExchangeRate(ctx: DataContext, actor: Actor): Promise<number> {
  void actor;
  return Number(await setting<number>(ctx, "usd_to_inr", 0));
}

export async function updateModelPricing(
  ctx: DataContext,
  actor: Actor,
  input: { model_name: string; input_usd_per_million: number; output_usd_per_million: number },
): Promise<void> {
  assertAdmin(actor);
  const before = await ctx.db.query.aiModelPricing.findFirst({ where: eq(aiModelPricing.model_name, input.model_name) });
  if (!before) throw new InvalidInputError("Could not save that price.");
  const after = {
    ...before,
    input_usd_per_million: input.input_usd_per_million,
    output_usd_per_million: input.output_usd_per_million,
    updated_by: actor.id,
  };
  await ctx.db.batch([
    ctx.db
      .update(aiModelPricing)
      .set({ input_usd_per_million: after.input_usd_per_million, output_usd_per_million: after.output_usd_per_million, updated_by: actor.id })
      .where(eq(aiModelPricing.model_name, input.model_name)),
    auditInsert(ctx, actor, "ai_model_pricing", input.model_name, "UPDATE", before, after),
  ]);
}

/** Admin-editable settings and their allowed values. */
const SETTINGS = {
  usd_to_inr: (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1000,
  ai_hourly_limit_per_user: (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100_000,
} as const;

export async function updateSetting(ctx: DataContext, actor: Actor, key: keyof typeof SETTINGS, value: unknown): Promise<void> {
  assertAdmin(actor);
  if (!Object.hasOwn(SETTINGS, key) || !SETTINGS[key](value)) throw new InvalidInputError("That value is not allowed.");
  const before = await ctx.db.query.appSettings.findFirst({ where: eq(appSettings.key, key) });
  await ctx.db.batch([
    ctx.db
      .insert(appSettings)
      .values({ key, value, updated_by: actor.id })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updated_by: actor.id } }),
    auditInsert(ctx, actor, "app_settings", key, before ? "UPDATE" : "INSERT", before ?? null, { key, value }),
  ]);
}

type Bucket = { calls: number; input_tokens: number; output_tokens: number; cost_inr: number };

export type AiUsageSummary = Bucket & {
  by_agent: (Bucket & { user_id: string | null; agent_name: string })[];
  by_feature: (Bucket & { feature_name: string })[];
  by_model: (Bucket & { model_name: string })[];
  by_day: { day: string; calls: number; cost_inr: number }[];
};

/** Usage between two times: everyone's for admins, the caller's own for agents. */
export async function aiUsageSummary(ctx: DataContext, actor: Actor, from: Date, to: Date = new Date()): Promise<AiUsageSummary> {
  const rows = await ctx.db
    .select()
    .from(aiUsageLogs)
    .where(
      and(
        gte(aiUsageLogs.created_at, from.toISOString()),
        lt(aiUsageLogs.created_at, to.toISOString()),
        isAdmin(actor) ? undefined : eq(aiUsageLogs.user_id, actor.id),
      ),
    );
  const empty = (): Bucket => ({ calls: 0, input_tokens: 0, output_tokens: 0, cost_inr: 0 });
  const add = (b: Bucket, r: (typeof rows)[number]) => {
    b.calls += 1;
    b.input_tokens += r.input_tokens;
    b.output_tokens += r.output_tokens;
    b.cost_inr += r.cost_inr;
    return b;
  };
  const group = <K extends string>(key: (r: (typeof rows)[number]) => string, extra: (r: (typeof rows)[number]) => Record<K, unknown>) => {
    const map = new Map<string, Bucket & Record<K, unknown>>();
    for (const r of rows) {
      const k = key(r);
      if (!map.has(k)) map.set(k, { ...empty(), ...extra(r) } as Bucket & Record<K, unknown>);
      add(map.get(k)!, r);
    }
    return [...map.values()].sort((a, b) => b.cost_inr - a.cost_inr);
  };
  const total = rows.reduce(add, empty());
  const days = new Map<string, { day: string; calls: number; cost_inr: number }>();
  for (const r of rows) {
    const day = businessDateOf(r.created_at);
    const d = days.get(day) ?? { day, calls: 0, cost_inr: 0 };
    d.calls += 1;
    d.cost_inr += r.cost_inr;
    days.set(day, d);
  }
  return {
    ...total,
    by_agent: group((r) => `${r.user_id}|${r.agent_name}`, (r) => ({ user_id: r.user_id, agent_name: r.agent_name })) as AiUsageSummary["by_agent"],
    by_feature: group((r) => r.feature_name, (r) => ({ feature_name: r.feature_name })) as AiUsageSummary["by_feature"],
    by_model: group((r) => r.model_name, (r) => ({ model_name: r.model_name })) as AiUsageSummary["by_model"],
    by_day: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}
