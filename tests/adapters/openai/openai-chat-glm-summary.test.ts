import { describe, expect, spyOn, test } from "bun:test";
import { buildOpenAIChatPassthroughRequest, createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { protectGlmSummaryBudget, resolveMaxTokens } from "../../../src/adapters/openai-chat/summary-budget";
import { chatCompletionsToResponsesBody } from "../../../src/chat/inbound";
import { concreteComboRequestBody } from "../../../src/combos/request";
import { parseRequest } from "../../../src/responses/parser";
import type { OcxProviderConfig } from "../../../src/types";
import { estimateInputTokens } from "../../../src/lib/request-input-estimate";
import { routeModel } from "../../../src/router";
import type { OcxConfig } from "../../../src/types";

const model = "glm-5.3-flash";
const provider: OcxProviderConfig = {
  adapter: "openai-chat", baseUrl: "https://api.z.ai/api/coding/paas/v4",
  reasoningEfforts: ["low", "medium", "high", "max"],
};
// Aside's emergency checkpoint: a summary instruction plus the transcript it summarizes (#5465).
const transcript = `<conversation>${"User: implement the feature and keep the tests green.\n".repeat(60)}</conversation>`;
const messages = [
  { role: "system", content: "You are a context-summarization assistant. Produce a checkpoint." },
  { role: "user", content: transcript },
];
function bodies(overrides: Record<string, unknown> = {}, config = provider) {
  const raw = { model, messages, max_tokens: 512, reasoning_effort: "max", ...overrides };
  const parsed = parseRequest(chatCompletionsToResponsesBody(raw));
  return [
    JSON.parse(createOpenAIChatAdapter(config).buildRequest(parsed).body),
    JSON.parse(buildOpenAIChatPassthroughRequest(config, raw, String(raw.model), false).body),
  ];
}

describe("GLM tiny standalone summary compatibility", () => {
  test.each([1, 512, 819, 1024])("raises cap %i and lowers effort on both Chat paths", cap => {
    for (const body of bodies({ max_tokens: cap })) {
      expect(body.max_tokens).toBe(8192);
      expect(body.reasoning_effort).toBe("low");
      expect(body.messages).toEqual(messages);
    }
  });
  test("final adapter wins after successive combo force overrides", () => {
    let raw = chatCompletionsToResponsesBody({ model, messages, max_tokens: 819, reasoning_effort: "high" });
    for (const target of [{ provider: "proxy", model: "inner" }, { provider: "zai", model }]) {
      raw = concreteComboRequestBody(raw, target, "max", provider.reasoningEfforts, "strict", "force");
    }
    const parsed = parseRequest(raw);
    parsed.modelId = model;
    expect(parsed.options.reasoning).toBe("max");
    const body = JSON.parse(createOpenAIChatAdapter(provider).buildRequest(parsed).body);
    expect(body.max_tokens).toBe(8192);
    expect(body.reasoning_effort).toBe("low");
    expect(parsed.options.maxOutputTokens).toBe(819);
    expect(parsed.options.reasoning).toBe("max");
  });
  test.each([0, -1, 1025, 4096, undefined])("preserves cap outside the mitigation: %s", cap => {
    for (const body of bodies({ max_tokens: cap })) {
      expect(body.max_tokens).toBe(cap);
      expect(body.reasoning_effort).toBe("max");
    }
  });
  test("does not change other models, ordinary prompts, tools, or ongoing conversations", () => {
    for (const overrides of [
      { model: "glm-5.3" }, { model: "glm-5.3-flashx" }, { model: "gpt-5" },
      { messages: [{ role: "system", content: "Be helpful." }, { role: "user", content: "Summarize this article." }] },
      { messages: [...messages, { role: "assistant", content: "Previous checkpoint" }] },
      { tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: {} } } }] },
    ]) for (const body of bodies(overrides)) {
      expect(body.max_tokens).toBe(512);
      expect(body.reasoning_effort).toBe("max");
    }
  });
});

describe("GLM summary mitigation stays inside its boundary (#5953 review)", () => {
  const untouched = (body: Record<string, unknown>, effort = "max") => {
    expect(body.max_tokens).toBe(512);
    expect(body.reasoning_effort).toBe(effort);
  };
  test("another gateway serving the same model id is left alone", () => {
    for (const baseUrl of ["https://example.com/v1", "https://evilz.ai/api/v4", "not a url"]) {
      for (const body of bodies({}, { ...provider, baseUrl })) untouched(body);
    }
  });
  test("a summarization system prompt with an ordinary short user message is not a checkpoint", () => {
    const probe = [messages[0], { role: "user", content: "Hello" }];
    for (const body of bodies({ messages: probe })) untouched(body);
  });
  test("a checkpoint transcript under the minimum length is not rewritten", () => {
    const short = [messages[0], { role: "user", content: "<conversation>User: hi.</conversation>" }];
    for (const body of bodies({ messages: short })) untouched(body);
  });
  /** The only patterns detection may scan the transcript with: the two fixed tags. */
  const FIXED_TAG_SCANS = ["<conversation>", "<\\/conversation>"];
  /** Runs detection while counting scans/copies targeted at the transcript — deterministic, unlike a wall-clock bound. */
  const detectWithProbe = (userContent: string) => {
    const scans: string[] = [];
    const copies: string[] = [];
    const origExec = RegExp.prototype.exec;
    const execProbe = spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, str: string) {
      if (str === userContent) scans.push(this.source);
      return origExec.call(this, str);
    });
    const copyProbes = (["toLowerCase", "toUpperCase", "toLocaleLowerCase", "toLocaleUpperCase"] as const).map(name => {
      const orig = String.prototype[name];
      return spyOn(String.prototype, name).mockImplementation(function (this: unknown) {
        if (String(this) === userContent) copies.push(name);
        return orig.call(this as string);
      });
    });
    try {
      const result = protectGlmSummaryBudget({
        model, max_tokens: 512,
        messages: [messages[0], { role: "user", content: userContent }],
      }, provider.baseUrl, "max");
      // A call count cannot bound work inside one scan — pinning every transcript scan to a
      // fixed tag is what fails the original greedy `[\s\S]*` pass, not the count alone.
      for (const source of scans) expect(FIXED_TAG_SCANS).toContain(source);
      return { result, scans, copies };
    } finally {
      execProbe.mockRestore();
      for (const probe of copyProbes) probe.mockRestore();
    }
  };
  test("rejects many unmatched conversation openings with a bounded number of transcript scans", () => {
    const { result, scans, copies } = detectWithProbe("<conversation>".repeat(32_000));
    expect(result).toBeFalse();
    expect(scans.length).toBeLessThanOrEqual(2);
    expect(copies).toEqual([]);
  });
  test("detects an uppercase checkpoint in place, without a transcript-sized normalized copy", () => {
    const transcript = `<CONVERSATION>${"LOREM IPSUM DOLOR SIT AMET.\n".repeat(200)}</CONVERSATION>`;
    const { result, scans, copies } = detectWithProbe(transcript);
    expect(result).toBeTrue();
    expect(scans.length).toBeLessThanOrEqual(2);
    expect(copies).toEqual([]);
  });
  test.each(["low", "medium"])("an effective %s effort is not overridden", effort => {
    for (const body of bodies({ reasoning_effort: effort })) untouched(body, effort);
  });
  test("each cap field is judged on its own", () => {
    const [, mixedLarge] = bodies({ max_tokens: 512, max_completion_tokens: 2048 });
    expect(mixedLarge.max_tokens).toBe(8192);
    expect(mixedLarge.max_completion_tokens).toBe(2048);
    const [, mixedSmall] = bodies({ max_tokens: 4096, max_completion_tokens: 512 });
    expect(mixedSmall.max_tokens).toBe(4096);
    expect(mixedSmall.max_completion_tokens).toBe(8192);
  });
});

// La reserva depende del destino y del contenido, nunca de un tope global de la CLI.
describe("presupuesto dinámico por modelo Chat", () => {
  const raw = { model: "small", messages: [{ role: "user", content: "entrada ".repeat(800) }], max_tokens: 32000 };
  const policy: OcxProviderConfig = {
    adapter: "openai-chat", baseUrl: "https://example.test/v1",
    modelContextWindows: { small: 32768, large: 1048576, inputOnly: 131072 },
    modelMaxInputTokens: { inputOnly: 8192 },
    modelMaxOutputTokens: { large: 64000 },
  };
  test("las dos rutas usan el contexto del destino y descuentan la entrada", () => {
    const parsed = parseRequest(chatCompletionsToResponsesBody(raw));
    const expected = 32768 - Math.ceil(estimateInputTokens(parsed, "small", policy) * 1.25);
    expect(expected).toBeGreaterThan(8192);
    expect(resolveMaxTokens(policy, parsed)).toBe(expected);
    const translated = JSON.parse(createOpenAIChatAdapter(policy).buildRequest(parsed).body);
    const native = JSON.parse(buildOpenAIChatPassthroughRequest(policy, raw, "small", false).body);
    expect(translated.max_tokens).toBe(expected);
    expect(native.max_tokens).toBe(expected);
  });
  test("un modelo grande conserva una salida mayor sin heredar la ventana pequeña", () => {
    const parsed = parseRequest(chatCompletionsToResponsesBody({ ...raw, model: "large", max_tokens: 120000 }));
    expect(resolveMaxTokens(policy, parsed)).toBe(64000);
    expect(resolveMaxTokens({ ...policy, modelMaxOutputTokens: {} }, parsed)).toBe(120000);
  });
  test("el cap exclusivo de entrada no se confunde con el contexto total", () => {
    const parsed = parseRequest(chatCompletionsToResponsesBody({ ...raw, model: "inputOnly" }));
    expect(resolveMaxTokens(policy, parsed)).toBe(32000);
  });
  test("sin metadatos conserva la solicitud y no inventa capacidades", () => {
    const parsed = parseRequest(chatCompletionsToResponsesBody({ ...raw, model: "unknown", max_tokens: 90000 }));
    expect(resolveMaxTokens(policy, parsed)).toBe(90000);
    parsed.options.maxOutputTokens = undefined;
    expect(resolveMaxTokens(policy, parsed)).toBeUndefined();
  });
  test("recalcula después de una edición de metadatos y respeta cotas menores del cliente", () => {
    const parsed = parseRequest(chatCompletionsToResponsesBody({ ...raw, max_tokens: 500 }));
    expect(resolveMaxTokens(policy, parsed)).toBe(500);
    const updated = { ...policy, modelContextWindows: { small: 128000 } };
    parsed.options.maxOutputTokens = 80000;
    expect(resolveMaxTokens(updated, parsed)).toBe(80000);
    expect(resolveMaxTokens(policy, parsed)).toBeLessThan(32768);
  });
});

test("el presupuesto de resumen respeta la salida máxima declarada del destino", () => {
  const capped = { ...provider, modelMaxOutputTokens: { [model]: 1024 } };
  for (const body of bodies({}, capped)) expect(body.max_tokens).toBe(1024);
});

test("la ruta proyecta la ventana del catálogo y recalcula al cambiar de modelo", () => {
  const config = { port: 0, defaultProvider: "demo", providers: {
    demo: { adapter: "openai-chat", baseUrl: "https://example.test/v1", models: ["small", "large"] },
  }, customModels: [
    { id: "s", provider: "demo", modelId: "small", contextWindow: 32768 },
    { id: "l", provider: "demo", modelId: "large", contextWindow: 262144 },
  ] } as OcxConfig;
  const small = routeModel(config, "demo/small");
  const large = routeModel(config, "demo/large");
  expect(small.provider.modelContextWindows?.small).toBe(32768);
  expect(small.staticPolicy.model.contextWindow).toBe(32768);
  expect(large.provider.modelContextWindows?.large).toBe(262144);
  expect(config.providers.demo.modelContextWindows).toBeUndefined();
  config.customModels![0].contextWindow = 65536;
  expect(routeModel(config, "demo/small").provider.modelContextWindows?.small).toBe(65536);
});
