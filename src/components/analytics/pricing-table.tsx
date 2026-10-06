"use client";

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";

import { updateExchangeRate, updateModelPricing } from "@/app/(app)/admin/ai-usage/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Tables } from "@/lib/database.types";

type Model = Tables<"ai_model_pricing">;

function SaveState({ state }: { state: "idle" | "saving" | "saved" | string }) {
  if (state === "saving") return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  if (state === "saved") return <Check className="size-4 text-success" />;
  if (state === "idle") return null;
  return <span className="text-xs text-destructive">{state}</span>;
}

/** Editable Gemini prices and the USD to INR rate, admin only. */
export function PricingTable({ models, usdToInr }: { models: Model[]; usdToInr: number }) {
  const [states, setStates] = useState<Record<string, string>>({});
  const [rateState, setRateState] = useState<string>("idle");
  const [, startTransition] = useTransition();

  const mark = (key: string, value: string) => {
    setStates((s) => ({ ...s, [key]: value }));
    if (value === "saved") setTimeout(() => setStates((s) => ({ ...s, [key]: "idle" })), 2000);
  };

  return (
    <div className="space-y-5">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-sm">
          <thead className="text-left text-xs tracking-wide text-muted-foreground uppercase">
            <tr className="border-b">
              <th className="py-2 pr-3">Model</th>
              <th className="px-3 py-2">Input $ / 1M</th>
              <th className="px-3 py-2">Output $ / 1M</th>
              <th className="py-2 pl-3" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {models.map((model) => (
              <tr key={model.model_name}>
                <td className="py-2 pr-3">
                  <p className="font-medium">{model.display_name}</p>
                  <p className="text-xs text-muted-foreground">{model.model_name}</p>
                </td>
                <td colSpan={3} className="py-2">
                  <form
                    className="flex flex-wrap items-center gap-2"
                    action={(formData) => {
                      mark(model.model_name, "saving");
                      startTransition(async () => {
                        const result = await updateModelPricing(formData);
                        mark(model.model_name, result.ok ? "saved" : result.error);
                      });
                    }}
                  >
                    <input type="hidden" name="model_name" value={model.model_name} />
                    <Input
                      name="input_usd_per_million"
                      type="number"
                      step="0.0001"
                      min="0"
                      defaultValue={model.input_usd_per_million}
                      aria-label={`Input price for ${model.display_name}`}
                      className="h-8 w-28"
                    />
                    <Input
                      name="output_usd_per_million"
                      type="number"
                      step="0.0001"
                      min="0"
                      defaultValue={model.output_usd_per_million}
                      aria-label={`Output price for ${model.display_name}`}
                      className="h-8 w-28"
                    />
                    <Button type="submit" size="sm" variant="outline">
                      Save
                    </Button>
                    <SaveState state={states[model.model_name] ?? "idle"} />
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form
        className="flex flex-wrap items-end gap-2 border-t pt-4"
        action={(formData) => {
          setRateState("saving");
          startTransition(async () => {
            const result = await updateExchangeRate(formData);
            setRateState(result.ok ? "saved" : result.error);
            if (result.ok) setTimeout(() => setRateState("idle"), 2000);
          });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="usd_to_inr">Exchange rate (₹ per $)</Label>
          <Input
            id="usd_to_inr"
            name="usd_to_inr"
            type="number"
            step="0.01"
            min="0"
            defaultValue={usdToInr}
            className="h-8 w-32"
          />
        </div>
        <Button type="submit" size="sm" variant="outline">
          Save rate
        </Button>
        <SaveState state={rateState} />
      </form>
    </div>
  );
}
