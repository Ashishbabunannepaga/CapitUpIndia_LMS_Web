import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Gemini wrapper with the SDK and data layer mocked: model fallback,
// rate limiting, usage logging and the no-key path.

const generateContent = vi.fn();
const inserted: Record<string, unknown>[] = [];
let usageCount = 0;
let hourlyLimit: unknown = "5";

vi.mock("server-only", () => ({}));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));
vi.mock("@/server/data/ai", () => ({
  // The data layer falls back to 200 when the setting is missing.
  aiCallsThisHour: async () => ({ used: usageCount, limit: Number(hourlyLimit ?? 200) }),
  logAiUsage: async (
    _ctx: unknown,
    u: { id: string; full_name: string },
    call: { feature: string; model: string; inputTokens: number; outputTokens: number },
  ) => {
    inserted.push({
      user_id: u.id,
      agent_name: u.full_name,
      feature_name: call.feature,
      model_name: call.model,
      input_tokens: call.inputTokens,
      output_tokens: call.outputTokens,
    });
  },
}));

const user = { id: "00000000-0000-0000-0000-000000000001", full_name: "Priya" };
const base = {
  ctx: {} as never,
  user,
  feature: "lead_intake" as const,
  models: ["model-a", "model-b"],
  contents: "hello",
  temperature: 0,
};

async function load() {
  vi.resetModules();
  return import("@/lib/ai/gemini");
}

beforeEach(() => {
  generateContent.mockReset();
  inserted.length = 0;
  usageCount = 0;
  hourlyLimit = "5";
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const reply = (text: string | undefined, tokens = { promptTokenCount: 10, candidatesTokenCount: 5 }) => ({
  text,
  usageMetadata: tokens,
});

describe("generate", () => {
  it("refuses clearly when no key is configured", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const { generate, isAiConfigured, AiUnavailableError } = await load();
    expect(isAiConfigured()).toBe(false);
    await expect(generate({ ...base, parse: (t) => t })).rejects.toBeInstanceOf(AiUnavailableError);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("returns the first model's answer and logs its real token usage", async () => {
    generateContent.mockResolvedValueOnce(
      reply("ok", { promptTokenCount: 10, toolUsePromptTokenCount: 2, candidatesTokenCount: 5, thoughtsTokenCount: 3 } as never),
    );
    const { generate } = await load();
    await expect(generate({ ...base, parse: (t) => t.toUpperCase() })).resolves.toEqual({ value: "OK", model: "model-a" });
    expect(inserted).toEqual([
      {
        user_id: user.id,
        agent_name: "Priya",
        feature_name: "lead_intake",
        model_name: "model-a",
        input_tokens: 12,
        output_tokens: 8,
      },
    ]);
  });

  it("falls back to the next model on an error, an empty answer or a parse failure", async () => {
    generateContent
      .mockRejectedValueOnce(new Error("503 overloaded"))
      .mockResolvedValueOnce(reply("   "))
      .mockResolvedValueOnce(reply("not json"))
      .mockResolvedValueOnce(reply('{"a":1}'));
    const { generate, parseJsonObject } = await load();
    const result = await generate({ ...base, models: ["m1", "m2", "m3", "m4"], parse: parseJsonObject });
    expect(result).toEqual({ value: { a: 1 }, model: "m4" });
    // Every model that answered is billed, even when its answer was unusable.
    expect(inserted.map((r) => r.model_name)).toEqual(["m2", "m3", "m4"]);
  });

  it("reports quota exhaustion in plain words when every model fails", async () => {
    generateContent.mockRejectedValue(new Error("429 RESOURCE_EXHAUSTED: quota exceeded"));
    const { generate } = await load();
    await expect(generate({ ...base, parse: (t) => t })).rejects.toThrow("over its quota");
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("reports a generic failure otherwise", async () => {
    generateContent.mockRejectedValue(new Error("boom"));
    const { generate } = await load();
    await expect(generate({ ...base, parse: (t) => t })).rejects.toThrow("could not process");
  });

  it("enforces the hourly limit before calling the model", async () => {
    usageCount = 5;
    const { generate, AiRateLimitError } = await load();
    await expect(generate({ ...base, parse: (t) => t })).rejects.toBeInstanceOf(AiRateLimitError);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("counts a bulk request as several calls", async () => {
    usageCount = 2;
    const { generate, AiRateLimitError } = await load();
    await expect(generate({ ...base, rateLimitCalls: 4, parse: (t) => t })).rejects.toBeInstanceOf(AiRateLimitError);
  });

  it("uses the default limit when the setting is missing, and none when it is 0", async () => {
    generateContent.mockResolvedValue(reply("ok"));
    hourlyLimit = null;
    usageCount = 199;
    let { generate } = await load();
    await expect(generate({ ...base, parse: (t) => t })).resolves.toMatchObject({ value: "ok" });
    usageCount = 200;
    await expect(generate({ ...base, parse: (t) => t })).rejects.toThrow("limit of 200");
    hourlyLimit = 0;
    usageCount = 10_000;
    ({ generate } = await load());
    await expect(generate({ ...base, parse: (t) => t })).resolves.toMatchObject({ value: "ok" });
  });
});

describe("parseJsonObject", () => {
  it("finds the object inside fences and chatter", async () => {
    const { parseJsonObject } = await load();
    expect(parseJsonObject('```json\n{"client_name":"Acme"}\n```')).toEqual({ client_name: "Acme" });
    expect(parseJsonObject('Here you go: {"a":{"b":2}} Let me know if {you} need more.')).toEqual({ a: { b: 2 } });
    expect(parseJsonObject('{"note":"use {braces} freely"}')).toEqual({ note: "use {braces} freely" });
  });

  it("rejects anything that is not a JSON object", async () => {
    const { parseJsonObject } = await load();
    expect(() => parseJsonObject("no json here")).toThrow();
    expect(() => parseJsonObject("{broken")).toThrow();
    expect(() => parseJsonObject("{} ")).not.toThrow();
    expect(() => parseJsonObject("{'single': 'quotes'}")).toThrow();
  });
});
