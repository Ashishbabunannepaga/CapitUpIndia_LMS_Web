import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import { aiCallsThisHour, aiUsageSummary, listModelPricing, logAiUsage, updateModelPricing, updateSetting } from "../ai";
import { nextRoundRobinAgents, pipelineAnalytics } from "../analytics";
import { attachCardToLead, cardForLead, MAX_CARD_PREVIEW_BYTES, uploadCard, type CardImage } from "../cards";
import { AccessDeniedError, InvalidInputError } from "../errors";
import { createLead, deleteLead, getLead } from "../leads";
import { createUser } from "../users";
import { PASSWORD, testWorld } from "./helpers";
import { visitingCardPreviews } from "@/server/db/schema";

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
  const small = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
  const bytesOf = async (card: CardImage) => new Uint8Array(await new Response(card.body).arrayBuffer());

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
    expect(await bytesOf(mine!)).toEqual(jpeg);
    expect(mine!.contentType).toBe("image/jpeg");
    expect(await cardForLead(w.ctx, w.neha, lead)).toBeNull();
    expect(await cardForLead(w.ctx, w.neha, lead, { full: true })).toBeNull();
    expect(await cardForLead(w.ctx, w.admin, lead)).not.toBeNull();
  });

  it("keeps a compressed copy in D1 and serves it, with the full photo on request", async () => {
    const path = await uploadCard(w.ctx, w.amit, jpeg, small);
    const row = await w.ctx.db.query.visitingCardPreviews.findFirst({ where: eq(visitingCardPreviews.path, path) });
    expect(row).toMatchObject({ mime: "image/jpeg", byte_size: small.byteLength, created_by: w.amit.id });
    const lead = await createLead(w.ctx, w.amit, { client_name: "Preview Co", visiting_card_path: path });
    expect(await bytesOf((await cardForLead(w.ctx, w.amit, lead))!)).toEqual(small);
    expect(await bytesOf((await cardForLead(w.ctx, w.amit, lead, { full: true }))!)).toEqual(jpeg);
  });

  it("rejects a preview that is not an image or is too large", async () => {
    await expect(uploadCard(w.ctx, w.amit, jpeg, new TextEncoder().encode("<svg>"))).rejects.toThrow("preview");
    const huge = new Uint8Array(MAX_CARD_PREVIEW_BYTES + 1);
    huge.set([0xff, 0xd8, 0xff]);
    await expect(uploadCard(w.ctx, w.amit, jpeg, huge)).rejects.toThrow("too large");
  });

  it("attaches a card to a lead the caller can see, and nobody else's", async () => {
    const lead = await createLead(w.ctx, w.amit, { client_name: "Attach Me Co" });
    await expect(attachCardToLead(w.ctx, w.neha, lead, jpeg, small)).rejects.toBeInstanceOf(InvalidInputError);
    expect((await getLead(w.ctx, w.amit, lead))!.visiting_card_path).toBeNull();

    await attachCardToLead(w.ctx, w.amit, lead, jpeg, small);
    const first = (await getLead(w.ctx, w.amit, lead))!.visiting_card_path;
    expect(first).toMatch(new RegExp(`^${w.amit.id}/`));
    expect(await bytesOf((await cardForLead(w.ctx, w.amit, lead))!)).toEqual(small);

    // An admin can replace it; the new card is what the lead shows.
    await attachCardToLead(w.ctx, w.admin, lead, jpeg);
    const second = (await getLead(w.ctx, w.amit, lead))!.visiting_card_path;
    expect(second).not.toBe(first);
    expect(second).toMatch(new RegExp(`^${w.admin.id}/`));
  });

  it("removes the compressed copy when the lead is deleted", async () => {
    const path = await uploadCard(w.ctx, w.amit, jpeg, small);
    const lead = await createLead(w.ctx, w.amit, { client_name: "Short Lived Co", visiting_card_path: path });
    await deleteLead(w.ctx, w.admin, lead);
    expect(await w.ctx.db.query.visitingCardPreviews.findFirst({ where: eq(visitingCardPreviews.path, path) })).toBeUndefined();
  });
});

describe("OpenAI model pricing", () => {
  it("prices a new app model from the central defaults without a migration", async () => {
    const before = Date.now() - 1;
    await logAiUsage(w.ctx, w.neha, { feature: "follow_up", model: "gpt-5.6-luna", inputTokens: 1_000_000, outputTokens: 1_000_000 });
    // (0.20 + 1.20) USD * 83.5 = 116.9 INR
    const summary = await aiUsageSummary(w.ctx, w.neha, new Date(before));
    expect(summary.by_model).toEqual([expect.objectContaining({ model_name: "gpt-5.6-luna", calls: 1 })]);
    expect(summary.cost_inr).toBeCloseTo(116.9, 4);
  });

  it("lists every app model for admins and keeps an admin's edited price", async () => {
    await updateModelPricing(w.ctx, w.admin, { model_name: "gpt-5.6-luna", input_usd_per_million: 0.5, output_usd_per_million: 2 });
    const rows = await listModelPricing(w.ctx, w.admin);
    expect(rows.map((r) => r.model_name)).toEqual(expect.arrayContaining(["gpt-5.6-luna", "gpt-5.6-terra"]));
    expect(rows.find((r) => r.model_name === "gpt-5.6-luna")).toMatchObject({ input_usd_per_million: 0.5, output_usd_per_million: 2 });
  });

  it("agents still can't change OpenAI prices", async () => {
    await expect(
      updateModelPricing(w.ctx, w.amit, { model_name: "gpt-5.6-terra", input_usd_per_million: 0, output_usd_per_million: 0 }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });
});
