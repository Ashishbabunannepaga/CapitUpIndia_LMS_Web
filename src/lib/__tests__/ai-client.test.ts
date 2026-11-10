import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The AI client with OpenAI's HTTP API (fetch) and the data layer mocked:
// request shape, model fallback, fatal errors, rate limiting, usage logging
// and the no-key path.

const fetchMock = vi.fn();
const inserted: Record<string, unknown>[] = [];
let usageCount = 0;
let hourlyLimit: unknown = "5";

vi.mock("server-only", () => ({}));
// Outside a request, after() throws, so the client logs straight away.
vi.mock("next/server", () => ({
  after: () => {
    throw new Error("after() called outside a request scope");
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
const choice = (model: string) => ({ model, reasoningEffort: "none" as const });
const base = {
  ctx: {} as never,
  user,
  feature: "lead_intake" as const,
  models: [choice("model-a"), choice("model-b")],
  text: "hello",
  maxOutputTokens: 100,
};

const ok = (content: string | null, usage = { prompt_tokens: 10, completion_tokens: 5 }, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content, ...extra }, finish_reason: "stop" }], usage }), { status: 200 });
const fail = (status: number, error: Record<string, unknown> = {}) => new Response(JSON.stringify({ error }), { status });

async function load() {
  vi.resetModules();
  return import("@/lib/ai/client");
}

beforeEach(() => {
  fetchMock.mockReset();
  inserted.length = 0;
  usageCount = 0;
  hourlyLimit = "5";
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("generate", () => {
  it("refuses clearly when no key is configured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { generate, isAiConfigured, AiUnavailableError } = await load();
    expect(isAiConfigured()).toBe(false);
    await expect(generate({ ...base, parse: (t) => t })).rejects.toBeInstanceOf(AiUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a strict JSON-schema request with the key in a header, never in the URL", async () => {
    fetchMock.mockResolvedValueOnce(ok('{"a":1}'));
    const { generate, parseJsonObject } = await load();
    await generate({
      ...base,
      models: [{ model: "gpt-5.6-luna", reasoningEffort: "low" }],
      system: "rules",
      image: { mime: "image/png", base64: "AAAA" },
      jsonSchema: { name: "lead", schema: { type: "object" } },
      parse: parseJsonObject,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: "gpt-5.6-luna",
      reasoning_effort: "low",
      max_completion_tokens: 100,
      store: false,
      response_format: { type: "json_schema", json_schema: { name: "lead", strict: true, schema: { type: "object" } } },
    });
    expect(body.messages[0]).toEqual({ role: "developer", content: "rules" });
    expect(body.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } });
    expect(body).not.toHaveProperty("temperature");
  });

  it("returns the first model's answer and logs its real token usage", async () => {
    fetchMock.mockResolvedValueOnce(ok("ok", { prompt_tokens: 12, completion_tokens: 8 }));
    const { generate } = await load();
    await expect(generate({ ...base, parse: (t) => t.toUpperCase() })).resolves.toEqual({ value: "OK", model: "model-a" });
    expect(inserted).toEqual([
      { user_id: user.id, agent_name: "Priya", feature_name: "lead_intake", model_name: "model-a", input_tokens: 12, output_tokens: 8 },
    ]);
  });

  it("falls back on a server error, an empty or refused answer, or a parse failure", async () => {
    fetchMock
      .mockResolvedValueOnce(fail(503, { message: "overloaded" }))
      .mockResolvedValueOnce(ok("   "))
      .mockResolvedValueOnce(ok(null, undefined, { refusal: "no" }))
      .mockResolvedValueOnce(ok("not json"))
      .mockResolvedValueOnce(ok('{"a":1}'));
    const { generate, parseJsonObject } = await load();
    const result = await generate({ ...base, models: ["m1", "m2", "m3", "m4", "m5"].map(choice), parse: parseJsonObject });
    expect(result).toEqual({ value: { a: 1 }, model: "m5" });
    // Every model that answered is billed, even when its answer was unusable.
    expect(inserted.map((r) => r.model_name)).toEqual(["m2", "m3", "m4", "m5"]);
  });

  it("falls back when a model times out", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError")).mockResolvedValueOnce(ok("ok"));
    const { generate } = await load();
    await expect(generate({ ...base, parse: (t) => t })).resolves.toEqual({ value: "ok", model: "model-b" });
  });

  it("stops at once on a refused key, with a message an admin can act on", async () => {
    fetchMock.mockResolvedValue(fail(401, { message: "Incorrect API key provided" }));
    const { generate } = await load();
    await expect(generate({ ...base, parse: (t) => t })).rejects.toThrow("OPENAI_API_KEY");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at once when the account is out of credit", async () => {
    fetchMock.mockResolvedValue(fail(429, { code: "insufficient_quota", message: "You exceeded your current quota" }));
    const { generate } = await load();
    await expect(generate({ ...base, parse: (t) => t })).rejects.toThrow("out of credit");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("says the service is busy when every model is rate limited", async () => {
    fetchMock.mockImplementation(async () => fail(429, { code: "rate_limit_exceeded", message: "Rate limit reached" }));
    const { generate } = await load();
    await expect(generate({ ...base, parse: (t) => t })).rejects.toThrow("busy");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a generic failure otherwise", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    const { generate } = await load();
    await expect(generate({ ...base, parse: (t) => t })).rejects.toThrow("could not process");
  });

  it("enforces the hourly limit before calling the model", async () => {
    usageCount = 5;
    const { generate, AiRateLimitError } = await load();
    await expect(generate({ ...base, parse: (t) => t })).rejects.toBeInstanceOf(AiRateLimitError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts a bulk request as several calls", async () => {
    usageCount = 2;
    const { generate, AiRateLimitError } = await load();
    await expect(generate({ ...base, rateLimitCalls: 4, parse: (t) => t })).rejects.toBeInstanceOf(AiRateLimitError);
  });

  it("uses the default limit when the setting is missing, and none when it is 0", async () => {
    fetchMock.mockImplementation(async () => ok("ok"));
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

describe("schemas", () => {
  it("meet OpenAI strict mode: every property required, nothing extra", async () => {
    const { leadSchema, bulkLeadsSchema } = await import("@/lib/ai/schemas");
    const check = (s: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean }) => {
      expect(s.additionalProperties).toBe(false);
      expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
    };
    check(leadSchema.schema);
    check(bulkLeadsSchema.schema);
    check(bulkLeadsSchema.schema.properties.leads.items);
  });
});
