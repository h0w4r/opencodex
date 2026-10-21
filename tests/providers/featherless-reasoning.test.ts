import { describe, expect, test } from "bun:test";
import {
  applyFeatherlessReasoningProfile,
  probeFeatherlessReasoningProfile,
  type FeatherlessReasoningProfile,
} from "../../src/providers/featherless-reasoning";
import type { OcxCustomModel, OcxProviderConfig } from "../../src/types";
import { reasoningDeclarationFromCard } from "../../src/providers/featherless-reasoning-declaration";

function responseForPrompt(prompt: string): Response {
  return Response.json({ formatted_prompt: prompt, token_count: prompt.length, template_info: {} });
}

function probeFetch(options: { toggle: boolean; budget: boolean }): typeof fetch {
  return (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      chat_template_kwargs?: { enable_thinking?: boolean; thinking_budget?: number };
    };
    const kwargs = body.chat_template_kwargs;
    if (!kwargs) return responseForPrompt("DEFAULT-ON");
    if (kwargs.enable_thinking === false) return responseForPrompt(options.toggle ? "OFF" : "DEFAULT-ON");
    if (!options.toggle) return responseForPrompt("DEFAULT-ON");
    if (options.budget && kwargs.thinking_budget !== undefined) {
      return responseForPrompt(`ON-BUDGET-${kwargs.thinking_budget}`);
    }
    return responseForPrompt("DEFAULT-ON");
  }) as typeof fetch;
}

describe("Featherless reasoning discovery", () => {
  test("el prefijo real de la plantilla activa la recuperación sin depender del nombre", async () => {
    const profile = await probeFeatherlessReasoningProfile("example/prefill", "secret", {
      fetch: (async (_input, init) => {
        const kwargs = JSON.parse(String(init?.body)).chat_template_kwargs;
        return responseForPrompt(kwargs?.enable_thinking === false ? "assistant\n" : "assistant\n<think>\n");
      }) as typeof fetch,
    });
    expect(profile.evidence.thinkingPrefill).toBe(true);
    const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.featherless.ai/v1" };
    applyFeatherlessReasoningProfile(provider, { id: "prefill", provider: "featherless", modelId: "example/prefill" }, profile);
    expect(provider.inlineThinkTagModels).toContain("example/prefill");
    expect(JSON.stringify(profile)).not.toContain("assistant");
  });
  test("publishes only a binary ladder when the toggle works but the budget is ignored", async () => {
    const profile = await probeFeatherlessReasoningProfile("Qwen/Qwen3.8-27B", "secret", {
      fetch: probeFetch({ toggle: true, budget: false }),
      now: () => new Date("2026-09-20T00:00:00.000Z"),
    });

    expect(profile).toMatchObject({
      kind: "toggle",
      complete: true,
      reasoningEfforts: ["none", "high"],
      defaultReasoningEffort: "high",
      defaultEnabled: true,
      checkedAt: "2026-09-20T00:00:00.000Z",
    });
    expect(profile.evidence.statuses).toEqual([200, 200, 200, 200, 200]);
    expect(profile.evidence.budgetLowHash).toBe(profile.evidence.budgetHighHash);
  });

  test("publishes the complete Codex budget ladder only after two budgets change the template", async () => {
    const profile = await probeFeatherlessReasoningProfile("example/budget-model", "secret", {
      fetch: probeFetch({ toggle: true, budget: true }),
    });
    expect(profile.kind).toBe("budget");
    expect(profile.complete).toBe(true);
    expect(profile.reasoningEfforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(profile.evidence.budgetLowHash).not.toBe(profile.evidence.budgetHighHash);
  });

  test("hides the effort picker when Featherless accepts but ignores the kwargs", async () => {
    const profile = await probeFeatherlessReasoningProfile("example/fixed", "secret", {
      fetch: probeFetch({ toggle: false, budget: false }),
    });
    expect(profile).toMatchObject({
      kind: "fixed-or-unknown",
      complete: true,
      reasoningEfforts: [],
      defaultEnabled: null,
    });
  });

  test("retries a transient formatter failure before classifying the model", async () => {
    let calls = 0;
    const stable = probeFetch({ toggle: true, budget: false });
    const flaky = (async (input, init) => {
      calls++;
      if (calls === 1) return new Response("busy", { status: 503 });
      return stable(input, init);
    }) as typeof fetch;
    const profile = await probeFeatherlessReasoningProfile("example/flaky", "secret", {
      fetch: flaky,
      retryDelayMs: 0,
    });
    expect(profile.kind).toBe("toggle");
    expect(profile.complete).toBe(true);
    expect(calls).toBe(16);
  });

  test("projects an evidence-backed toggle onto catalog and transport without fake tiers", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.featherless.ai/v1",
      reasoningEfforts: [],
    };
    const custom: OcxCustomModel = { id: "row", provider: "featherless", modelId: "deepseek-ai/DeepSeek-V4.1-Flash" };
    const profile: FeatherlessReasoningProfile = {
      kind: "toggle",
      complete: true,
      reasoningEfforts: ["none", "high"],
      defaultReasoningEffort: "high",
      defaultEnabled: true,
      checkedAt: "2026-09-20T00:00:00.000Z",
      evidence: { source: "featherless-debug-chat-format", statuses: [200, 200, 200] },
    };

    applyFeatherlessReasoningProfile(provider, custom, profile);

    expect(custom).toMatchObject({ reasoningEfforts: ["none", "high"], defaultReasoningEffort: "high" });
    expect(provider.modelReasoningEfforts?.[custom.modelId]).toEqual(["none", "high"]);
    expect(provider.modelReasoningEffortMap?.[custom.modelId]).toEqual({ none: "disabled", high: "enabled" });
    expect(provider.modelSuppressSyntheticMax?.[custom.modelId]).toBe(true);
    expect(provider.preserveReasoningContentModels).toContain(custom.modelId);
    expect(provider.requiresReasoningPlaceholderModels).toContain(custom.modelId);
  });

  test("an inconclusive audit preserves a previously verified ladder", async () => {
    const unavailable = (async () => new Response("temporary", { status: 503 })) as typeof fetch;
    const profile = await probeFeatherlessReasoningProfile("deepseek-ai/DeepSeek-V4.1-Flash", "secret", {
      fetch: unavailable,
      retryDelayMs: 0,
    });
    const modelId = "deepseek-ai/DeepSeek-V4.1-Flash";
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.featherless.ai/v1",
      reasoningEfforts: [],
      modelReasoningEfforts: { [modelId]: ["none", "high"] },
      modelReasoningEffortMap: { [modelId]: { none: "disabled", high: "enabled" } },
    };
    const custom: OcxCustomModel = {
      id: "row",
      provider: "featherless",
      modelId,
      reasoningEfforts: ["none", "high"],
      defaultReasoningEffort: "high",
    };

    expect(profile.complete).toBe(false);
    applyFeatherlessReasoningProfile(provider, custom, profile);
    expect(custom.reasoningEfforts).toEqual(["none", "high"]);
    expect(provider.modelReasoningEfforts?.[modelId]).toEqual(["none", "high"]);
    expect(provider.modelReasoningEffortMap?.[modelId]).toEqual({ none: "disabled", high: "enabled" });
  });
});

describe("Featherless nominal effort evidence", () => {
  test("la declaración del autor distingue max real de aliases desconocidos que caen al default", async () => {
    const card = "The reasoning_effort parameter accepts three levels: `low`, `high`, and `max`. It defaults to `max`.";
    expect(reasoningDeclarationFromCard(card, "https://huggingface.co/example/model/raw/main/README.md")?.efforts).toEqual(["low", "high", "max"]);
    const profile = await probeFeatherlessReasoningProfile("example/declared", "secret", {
      fetch: (async (url, init) => {
        if (String(url).startsWith("https://huggingface.co/")) {
          expect(new Headers(init?.headers).has("authorization")).toBe(false);
          return new Response(card);
        }
        const body = JSON.parse(String(init?.body));
        const effort = body.chat_template_kwargs?.reasoning_effort;
        if (effort) expect(body.reasoning_effort).toBe(effort);
        return responseForPrompt(effort === "low" ? "LOW" : effort === "high" ? "HIGH" : "MAX");
      }) as typeof fetch,
    });
    expect(profile.reasoningEfforts).toEqual(["low", "high", "max"]);
    expect(profile.defaultReasoningEffort).toBe("max");
    expect(profile.evidence.declaration?.url).toContain("huggingface.co/example/declared/");
  });
  test("una escala nominal con default apagado no se declara always-on", async () => {
    const profile = await probeFeatherlessReasoningProfile("example/named-toggle", "secret", {
      fetch: (async (_input, init) => {
        const kwargs = JSON.parse(String(init?.body)).chat_template_kwargs;
        if (kwargs?.reasoning_effort) {
          if (!["low", "high"].includes(kwargs.reasoning_effort)) return new Response(null, { status: 400 });
          return responseForPrompt("ON-" + kwargs.reasoning_effort);
        }
        return responseForPrompt(kwargs?.enable_thinking === true ? "ON-high" : "OFF");
      }) as typeof fetch,
    });
    expect(profile).toMatchObject({ kind: "effort", defaultEnabled: false, defaultReasoningEffort: "none", reasoningEfforts: ["none", "low", "high"] });
  });
  test("discovers template effort levels even when thinking cannot be switched off", async () => {
    const profile = await probeFeatherlessReasoningProfile("example/always-on", "secret", {
      fetch: (async (_input, init) => {
        const kwargs = JSON.parse(String(init?.body)).chat_template_kwargs;
        const effort = kwargs?.reasoning_effort;
        if (effort && !["low", "medium", "high"].includes(effort)) return new Response(null, { status: 400 });
        return responseForPrompt(`EFFORT-${effort ?? "medium"}`);
      }) as typeof fetch,
    });
    expect(profile.kind).toBe("effort");
    expect(profile.complete).toBe(true);
    expect(profile.reasoningEfforts).toEqual(["low", "medium", "high"]);
    expect(profile.defaultReasoningEffort).toBe("medium");
    const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.featherless.ai/v1" };
    const custom: OcxCustomModel = { id: "verified", provider: "featherless", modelId: "example/always-on" };
    applyFeatherlessReasoningProfile(provider, custom, profile);
    expect(provider.modelReasoningEffortMap?.[custom.modelId]?.low).toBe("template:low");
  });
  test("fixed-or-unknown controls do not discard actual reasoning replay", () => {
    const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.featherless.ai/v1" };
    const model: OcxCustomModel = { id: "fixed", provider: "featherless", modelId: "example/fixed" };
    applyFeatherlessReasoningProfile(provider, model, {
      kind: "fixed-or-unknown", complete: true, reasoningEfforts: [], defaultEnabled: null,
      checkedAt: new Date().toISOString(), evidence: { source: "featherless-debug-chat-format", statuses: [200,200,200] },
    });
    expect(model.reasoningEfforts).toEqual([]);
    expect(provider.preserveReasoningContentModels).toContain(model.modelId);
  });
});
