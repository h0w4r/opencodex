import { describe, expect, test } from "bun:test";
import {
  applyFeatherlessReasoningProfile,
  probeFeatherlessReasoningProfile,
  type FeatherlessReasoningProfile,
} from "../../src/providers/featherless-reasoning";
import type { OcxCustomModel, OcxProviderConfig } from "../../src/types";

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
  test("publishes only a binary ladder when the toggle works but the budget is ignored", async () => {
    const profile = await probeFeatherlessReasoningProfile("Qwen/Qwen3.8-27B", "secret", {
      fetch: probeFetch({ toggle: true, budget: false }),
      now: () => new Date("2026-09-20T00:00:00.000Z"),
    });

    expect(profile).toMatchObject({
      kind: "toggle",
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
    expect(profile.reasoningEfforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(profile.evidence.budgetLowHash).not.toBe(profile.evidence.budgetHighHash);
  });

  test("hides the effort picker when Featherless accepts but ignores the kwargs", async () => {
    const profile = await probeFeatherlessReasoningProfile("example/fixed", "secret", {
      fetch: probeFetch({ toggle: false, budget: false }),
    });
    expect(profile).toMatchObject({
      kind: "fixed-or-unknown",
      reasoningEfforts: [],
      defaultEnabled: true,
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
    expect(calls).toBe(6);
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
});
