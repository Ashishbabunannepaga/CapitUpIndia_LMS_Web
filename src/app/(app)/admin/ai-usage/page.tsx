import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/app-shell/page-header";
import { BarList, Panel, StatCard } from "@/components/analytics/charts";
import { PricingTable } from "@/components/analytics/pricing-table";
import { requireAdmin } from "@/lib/auth";
import { AI_FEATURE_LABELS, formatCount, formatInr, getAiUsageSummary, plural } from "@/lib/analytics";
import { formatDate, nowMs } from "@/lib/dates";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "AI Usage" };

const RANGES = { "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days", "365": "Last 12 months" } as const;
type RangeKey = keyof typeof RANGES;

function isRange(value: unknown): value is RangeKey {
  return typeof value === "string" && value in RANGES;
}

export default async function AiUsagePage({ searchParams }: PageProps<"/admin/ai-usage">) {
  await requireAdmin();
  const params = await searchParams;
  const range: RangeKey = isRange(params.range) ? params.range : "30";
  const days = Number(range);
  const from = new Date(nowMs() - days * 86_400_000);

  const supabase = await createClient();
  const [usage, { data: pricing }, { data: fx }] = await Promise.all([
    getAiUsageSummary(from),
    supabase.from("ai_model_pricing").select("*").order("model_name"),
    supabase.from("app_settings").select("value").eq("key", "usd_to_inr").maybeSingle(),
  ]);

  const tokens = usage.input_tokens + usage.output_tokens;
  const perDay = usage.cost_inr / days;

  return (
    <>
      <PageHeader
        title="AI Usage"
        description={`Every Gemini call, its tokens and its cost in rupees, since ${formatDate(from.toISOString().slice(0, 10))}.`}
        actions={
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(RANGES) as RangeKey[]).map((key) => (
              <Link
                key={key}
                href={`/admin/ai-usage?range=${key}`}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${
                  key === range ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent"
                }`}
              >
                {RANGES[key]}
              </Link>
            ))}
          </div>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Calls" value={usage.calls} />
        <StatCard label="Tokens" value={tokens} hint={`${formatCount(usage.input_tokens)} in · ${formatCount(usage.output_tokens)} out`} />
        <StatCard label="Cost" value={formatInr(usage.cost_inr)} />
        <StatCard label="Projected monthly" value={formatInr(perDay * 30)} hint={`${formatInr(perDay)} a day so far`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="By agent">
          <BarList
            data={usage.by_agent.map((row) => ({
              label: row.agent_name,
              value: Number(row.cost_inr),
              valueLabel: `${formatInr(Number(row.cost_inr))} · ${plural(row.calls, "call")}`,
            }))}
            emptyText="No AI usage in this period."
          />
        </Panel>

        <Panel title="By feature">
          <BarList
            data={usage.by_feature.map((row) => ({
              label: AI_FEATURE_LABELS[row.feature_name] ?? row.feature_name,
              value: Number(row.cost_inr),
              valueLabel: `${formatInr(Number(row.cost_inr))} · ${plural(row.calls, "call")}`,
              colorClass: "bg-indigo-500",
            }))}
            emptyText="No AI usage in this period."
          />
        </Panel>

        <Panel title="By model">
          <BarList
            data={usage.by_model.map((row) => ({
              label: row.model_name,
              value: Number(row.cost_inr),
              valueLabel: `${formatInr(Number(row.cost_inr))} · ${formatCount(
                Number(row.input_tokens) + Number(row.output_tokens),
              )} tokens`,
              colorClass: "bg-emerald-500",
            }))}
            emptyText="No AI usage in this period."
          />
        </Panel>

        <Panel title="Daily cost" description="Most recent days first">
          {usage.by_day.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No AI usage in this period.</p>
          ) : (
            <ul className="max-h-64 divide-y overflow-y-auto text-sm">
              {[...usage.by_day].reverse().map((day) => (
                <li key={day.day} className="flex items-center justify-between py-1.5">
                  <span>{formatDate(day.day)}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {plural(day.calls, "call")} · {formatInr(Number(day.cost_inr))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel
        title="Model pricing"
        description="USD per million tokens, converted at the exchange rate below. Costs are computed by the database from these values, so changing them affects new calls only."
        className="mt-6"
      >
        <PricingTable models={pricing ?? []} usdToInr={Number(fx?.value ?? 0)} />
      </Panel>
    </>
  );
}
