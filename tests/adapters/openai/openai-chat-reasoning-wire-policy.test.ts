import { describe, expect, test } from "bun:test";
import {
  buildOpenAIChatPassthroughRequest,
  createOpenAIChatAdapter,
} from "../../../src/adapters/openai-chat";
import { chatCompletionsToResponsesBody } from "../../../src/chat/inbound";
import { parseRequest } from "../../../src/responses/parser";
import type { OcxProviderConfig } from "../../../src/types";

const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://gateway.example.test/v1",
  apiKey: "sk-test",
  authMode: "key",
  reasoningWireFormat: "gateway-object",
  omitReasoningEffortWithToolsModels: ["reasoning-policy-model"],
};
const modelId = provider.omitReasoningEffortWithToolsModels![0]!;

const input: Record<string, unknown> = {
  model: modelId,
  messages: [{ role: "user", content: "What is the weather?" }],
  reasoning_effort: "none",
};
const tool: Record<string, unknown> = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
};
const inputWithTool: Record<string, unknown> = { ...input, tools: [tool] };

function finalBodies(rawInput: Record<string, unknown>): Record<"translated" | "native", Record<string, unknown>> {
  const parsed = parseRequest(chatCompletionsToResponsesBody(rawInput));
  const translated = createOpenAIChatAdapter(provider).buildRequest(parsed);
  const native = buildOpenAIChatPassthroughRequest(provider, rawInput, modelId, false);

  return {
    translated: JSON.parse(translated.body) as Record<string, unknown>,
    native: JSON.parse(native.body) as Record<string, unknown>,
  };
}

describe("OpenAI Chat reasoning wire policy parity", () => {
  test("plain reasoning disable uses the gateway object on both final wires", () => {
    const bodies = finalBodies(input);
    const projection = Object.fromEntries(Object.entries(bodies).map(([builder, body]) => [
      builder,
      {
        reasoning: body.reasoning,
        hasReasoningEffort: Object.hasOwn(body, "reasoning_effort"),
      },
    ]));

    expect(projection).toEqual({
      translated: { reasoning: { enabled: false }, hasReasoningEffort: false },
      native: { reasoning: { enabled: false }, hasReasoningEffort: false },
    });
  });

  test("a function tool survives while both final wires omit all reasoning fields", () => {
    const bodies = finalBodies(inputWithTool);
    const projection = Object.fromEntries(Object.entries(bodies).map(([builder, body]) => [
      builder,
      {
        tools: body.tools,
        hasReasoning: Object.hasOwn(body, "reasoning"),
        hasReasoningEffort: Object.hasOwn(body, "reasoning_effort"),
      },
    ]));

    expect(projection).toEqual({
      translated: { tools: [tool], hasReasoning: false, hasReasoningEffort: false },
      native: { tools: [tool], hasReasoning: false, hasReasoningEffort: false },
    });
  });
});

describe("Featherless effort parity across client protocols", () => {
  const id = "example/tool-reasoner";
  const featherless: OcxProviderConfig = {
    adapter: "openai-chat", baseUrl: "https://api.featherless.ai/v1", apiKey: "test-only",
    modelReasoningEfforts: { [id]: ["none", "high"] },
    modelReasoningEffortMap: { [id]: { none: "disabled", high: "enabled" } },
  };
  for (const effort of ["none", "high", "medium"]) {
    test(`Responses and raw Chat agree on ${effort}`, () => {
      const input = { model: id, messages: [{ role: "user", content: "Responde OK" }], reasoning_effort: effort, max_tokens: 1024 };
      const parsed = parseRequest(chatCompletionsToResponsesBody(input));
      const translated = createOpenAIChatAdapter(featherless).buildRequest(parsed);
      const direct = buildOpenAIChatPassthroughRequest(featherless, input, id, false);
      const a = JSON.parse(translated.body), b = JSON.parse(direct.body);
      expect(a.chat_template_kwargs).toEqual(b.chat_template_kwargs);
      expect(a.chat_template_kwargs.enable_thinking).toBe(effort !== "none");
      expect(b).not.toHaveProperty("reasoning_effort");
      expect(direct.reasoningLog).toBeDefined();
    });
  }
  test("a verified template effort is not emitted as an unsupported top-level field", () => {
    const named: OcxProviderConfig = { ...featherless,
      modelReasoningEfforts: { [id]: ["low", "medium", "high"] },
      modelReasoningEffortMap: { [id]: { low: "template:low", medium: "template:medium", high: "template:high" } },
    };
    const request = buildOpenAIChatPassthroughRequest(named, { model: id, messages: [], reasoning_effort: "low" }, id, false);
    const body = JSON.parse(request.body);
    expect(body.chat_template_kwargs.reasoning_effort).toBe("low");
    expect(request.reasoningLog?.wireField).toBe("chat_template_kwargs.reasoning_effort");
    expect(body).not.toHaveProperty("reasoning_effort");
  });
  test("a budget projection is identical across both ingress protocols", () => {
    const budget: OcxProviderConfig = { ...featherless, thinkingBudgetModels: [id],
      modelReasoningEfforts: { [id]: ["none", "low", "medium", "high"] },
      modelReasoningEffortMap: { [id]: { none: "disabled" } },
    };
    const input = { model: id, messages: [{role:"user",content:"OK"}], reasoning_effort: "medium", max_tokens: 1024 };
    const a = createOpenAIChatAdapter(budget).buildRequest(parseRequest(chatCompletionsToResponsesBody(input)));
    const b = buildOpenAIChatPassthroughRequest(budget, input, id, false);
    expect(JSON.parse(a.body).chat_template_kwargs).toEqual(JSON.parse(b.body).chat_template_kwargs);
    expect(JSON.parse(b.body).chat_template_kwargs.thinking_budget).toBe(512);
  });
});
