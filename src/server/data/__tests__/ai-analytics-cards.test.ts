import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { aiCallsThisHour, aiUsageSummary, logAiUsage, updateModelPricing, updateSetting } from "../ai";
import { nextRoundRobinAgents, pipelineAnalytics } from "../analytics";
import { cardForLead, uploadCard } from "../cards";
import { AccessDeniedError, InvalidInputError } from "../errors";
import { createLead } from "../leads";
import { createUser } from "../users";
import { PASSWORD, testWorld } from "./helpers";

// AI usage and pricing, analytics, bulk-import round-robin and visiting cards.

let w: Awaited<ReturnType<typeof testWorld>>;

beforeAll(async () => {
  w = await testWorld();
}, 60_000);

afterAll(async () => {
  await w?.dispose();
});

describe("AI usage", () => {
  it("prices each call in INR from the central pricing", async () => {
    await logAiUsage(w.ctx, w.amit, { feature: "lead_intake", model: "gemini-2.5-pro", inputTokens: 1_000_000, outputTokens: 100_000 });
    // (1.25 + 0.1 * 5.00) USD * 83.5 = 146.125 INR
    const summary = await aiUsageSummary(w.ctx, w.admin, new Date(Date.now() - 60_000));
    expect(summary.calls).toBe(1);
    expect(summary.cost_inr).toBeCloseTo(146.125, 4);
    expect(summary.by_feature[0]).toMatchObject({ feature_name: "lead_intake", calls: 1 });
    expect(summary.by_agent[0]).toMatchObject({ user_id: w.amit.id, agent_name: "Amit Agent" });
  });

  it("refuses to log a model without pricing", async () => {
    await expect(logAiUsage(w.ctx, w.amit, { feature: "other", model: "gpt-x", inputTokens: 1, outputTokens: 1 })).rejects.toThrow(
      "No pricing configured",
    );
  });

  it("agents see only their own usage", async () => {
    await logAiUsage(w.ctx, w.neha, { feature: "card_ocr", model: "gemini-2.5-flash", inputTokens: 10, outputTokens: 10 });
    const amit = await aiUsageSummary(w.ctx, w.amit, new Date(Date.now() - 60_000));
    expect(amit.calls).toBe(1);
    expect(amit.by_agent.map((a) => a.agent_name)).toEqual(["Amit Agent"]);
    expect((await aiUsageSummary(w.ctx, w.admin, new Date(Date.now() - 60_000))).calls).toBe(2);
  });

  it("counts calls in the last hour against the hourly limit", async () => {
    expect(await aiCallsThisHour(w.ctx, w.amit.id)).toEqual({ used: 1, limit: 200 });
    await updateSetting(w.ctx, w.admin, "ai_hourly_limit_per_user", 50);
    expect((await aiCallsThisHour(w.ctx, w.amit.id)).limit).toBe(50);
  });

  it("only admins change pricing and settings, within sane values", async () => {
    await expect(
      updateModelPricing(w.ctx, w.amit, { model_name: "gemini-2.5-pro", input_usd_per_million: 0, output_usd_per_million: 0 }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(updateSetting(w.ctx, w.amit, "usd_to_inr", 90)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(updateSetting(w.ctx, w.admin, "usd_to_inr", -1)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(updateSetting(w.ctx, w.admin, "timezone" as never, "UTC")).rejects.toBeInstanceOf(InvalidInputError);
    await updateModelPricing(w.ctx, w.admin, { model_name: "gemini-2.5-pro", input_usd_per_million: 2, output_usd_per_million: 6 });
    const audit = await w.d1.prepare("select actor_id from audit_logs where table_name = 'ai_model_pricing'").all<{ actor_id: string }>();
    expect(audit.results).toEqual([{ actor_id: w.admin.id }]);
  });
});

describe("analytics", () => {
  beforeAll(async () => {
    await createLead(w.ctx, w.amit, { client_name: "Analytics A", status: "Quoted", renewal_date: "2020-01-01" });
    await createLead(w.ctx, w.amit, { client_name: "Analytics B", status: "Closed Won" });
    await createLead(w.ctx, w.neha, { client_name: "Analytics C" });
    await createLead(w.ctx, w.admin, { client_name: "Analytics D" });
  });

  it("an agent's numbers cover only their leads", async () => {
    const amit = await pipelineAnalytics(w.ctx, w.amit);
    expect(amit.total).toBe(2);
    expect(amit.by_status).toEqual({ Quoted: 1, "Closed Won": 1 });
    expect(amit.renewals.overdue).toBe(1);
    expect(amit.agents).toHaveLength(1);
    expect(amit.agents[0]).toMatchObject({ agent_name: "Amit Agent", quoted: 1, won: 1, overdue_renewals: 1 });
  });

  it("admins see every lead and agent, with unassigned counted", async () => {
    const all = await pipelineAnalytics(w.ctx, w.admin);
    expect(all.total).toBe(4);
    expect(all.unassigned).toBe(1);
    expect(all.agents.map((a) => a.agent_name).sort()).toEqual(["Amit Agent", "Neha Agent", "Unassigned"]);
    expect(all.renewals_by_month).toHaveLength(12);
    expect(all.created_by_month.at(-1)!.count).toBe(4);
  });
});

describe("round-robin", () => {
  it("cycles through active agents in name order and continues where it stopped", async () => {
    await expect(nextRoundRobinAgents(w.ctx, w.amit, 1)).rejects.toBeInstanceOf(AccessDeniedError);
    const zara = await createUser(w.ctx, w.admin, { email: "zara@capitup.test", fullName: "Zara Agent", password: PASSWORD });
    const first = await nextRoundRobinAgents(w.ctx, w.admin, 4);
    expect(first).toEqual([w.amit.id, w.neha.id, zara.id, w.amit.id]);
    expect(await nextRoundRobinAgents(w.ctx, w.admin, 2)).toEqual([w.neha.id, zara.id]);
    expect(await nextRoundRobinAgents(w.ctx, w.admin, 0)).toEqual([]);
  });
});

describe("visiting cards", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

  it("stores only real images under the uploader's folder", async () => {
    const path = await uploadCard(w.ctx, w.amit, jpeg);
    expect(path).toMatch(new RegExp(`^${w.amit.id}/[0-9a-f-]{36}\\.jpg$`));
    await expect(uploadCard(w.ctx, w.amit, new TextEncoder().encode("<script>"))).rejects.toThrow("JPEG, PNG or WebP");
    await expect(uploadCard(w.ctx, w.amit, new Uint8Array())).rejects.toThrow("empty");
  });

  it("serves a card only to someone who can see the lead", async () => {
    const path = await uploadCard(w.ctx, w.amit, jpeg);
    const lead = await createLead(w.ctx, w.amit, { client_name: "Card Holder Co", visiting_card_path: path });
    const mine = await cardForLead(w.ctx, w.amit, lead);
    expect(new Uint8Array(await mine!.arrayBuffer())).toEqual(jpeg);
    expect(mine!.httpMetadata?.contentType).toBe("image/jpeg");
    expect(await cardForLead(w.ctx, w.neha, lead)).toBeNull();
    expect(await cardForLead(w.ctx, w.admin, lead)).not.toBeNull();
  });
});
