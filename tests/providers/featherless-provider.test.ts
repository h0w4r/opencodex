import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { buildCatalogEntries, clampEntryToCodexSupportedEfforts, gatherRoutedModels } from "../../src/codex/catalog";
import { catalogHintsFromModelsApiItem } from "../../src/codex/catalog/provider-fetch";
import { clearModelCache } from "../../src/codex/model-cache";
import { buildInitProviders } from "../../src/cli/init";
import { buildModelsRequest } from "../../src/oauth";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";
import {
  deriveInitProviders,
  deriveProviderPresets,
  providerConfigSeed,
} from "../../src/providers/derive";
import { resolveProviderModelDiscovery } from "../../src/providers/model-discovery";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routedSlug } from "../../src/providers/slug-codec";
import { routeModel } from "../../src/router";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";
import { fixturePath } from "../helpers/repo-root";

const FEATHERLESS_FIXTURE = readFileSync(fixturePath("featherless-models.json"), "utf8");
const BASE_URL = "https://api.featherless.ai/v1";
const TEST_KEY = "featherless-test-key";
const DISCOVERY_QUERY = {
  available_on_current_plan: "true",
  capabilities: "chat",
  page: "1",
  per_page: "100",
  sort: "-popularity",
} as const;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("featherless");
});

function registryEntry() {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "featherless");
  if (!entry) throw new Error("missing featherless registry entry");
  return entry;
}

function providerConfig(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "featherless",
    providers: {
      featherless: {
        adapter: "openai-chat",
        baseUrl: BASE_URL,
        authMode: "key",
        apiKey: TEST_KEY,
        liveModels: true,
        ...overrides,
      },
    },
  };
}

function expectDiscoveryUrl(input: RequestInfo | URL): void {
  const url = new URL(String(input));
  expect(`${url.origin}${url.pathname}`).toBe(`${BASE_URL}/models`);
  expect(Object.fromEntries(url.searchParams)).toEqual(DISCOVERY_QUERY);
}

describe("Featherless provider", () => {
  test("registers a bounded authenticated first-page discovery policy", () => {
    expect(registryEntry()).toMatchObject({
      id: "featherless",
      label: "Featherless AI",
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      authKind: "key",
      dashboardUrl: "https://featherless.ai/account/api-keys",
      liveModels: true,
      preserveCustomDestination: true,
      apiKeyValidation: "unknown",
      parallelToolCalls: false,
      reasoningEfforts: [],
      modelDiscovery: {
        path: "models",
        query: DISCOVERY_QUERY,
        maxResponseBytes: 131_072,
        maxModels: 100,
        filter: {
          allOf: [
            { path: ["available_on_current_plan"], equalsAny: [true] },
            { path: ["is_gated"], equalsAny: [false] },
            { path: ["features", "tool_use"], equalsAny: [true] },
          ],
        },
      },
    });
    expect(registryEntry().note).toContain("at most 100");
  });

  test("derives CLI and dashboard presets without persisting registry trust policy", () => {
    const entry = registryEntry();
    expect(buildInitProviders()).toEqual(deriveInitProviders());
    expect(KEY_LOGIN_PROVIDERS.featherless).toMatchObject({
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      dashboardUrl: entry.dashboardUrl,
      liveModels: true,
      reasoningEfforts: [],
    });
    expect(buildInitProviders().find(row => row.id === "featherless")).toMatchObject({
      kind: "key",
      adapter: "openai-chat",
      baseUrl: BASE_URL,
    });
    expect(deriveProviderPresets().find(row => row.id === "featherless")).toMatchObject({
      auth: "key",
      dashboardUrl: entry.dashboardUrl,
    });

    const seed = providerConfigSeed(entry);
    expect(seed).toMatchObject({
      adapter: "openai-chat",
      baseUrl: BASE_URL,
      authMode: "key",
      liveModels: true,
      parallelToolCalls: false,
      reasoningEfforts: [],
    });
    expect(seed).not.toHaveProperty("modelDiscovery");
    expect(seed).not.toHaveProperty("preserveCustomDestination");
    expect(KEY_LOGIN_PROVIDERS.featherless).not.toHaveProperty("modelDiscovery");
    expect(KEY_LOGIN_PROVIDERS.featherless).not.toHaveProperty("preserveCustomDestination");
  });

  test("uses the documented Bearer endpoint without treating its catalog as key proof", async () => {
    const request = buildModelsRequest(providerConfig().providers.featherless!, TEST_KEY, "featherless");
    expectDiscoveryUrl(request.url);
    expect(request.headers).toEqual({ Authorization: `Bearer ${TEST_KEY}` });

    globalThis.fetch = (async () => {
      throw new Error("catalog validation must not fetch");
    }) as typeof fetch;
    expect(await validateApiKey("featherless", KEY_LOGIN_PROVIDERS.featherless!, TEST_KEY)).toBe("unknown");
  });

  test("reads bounded boolean feature metadata without trusting it for admission by itself", () => {
    expect(catalogHintsFromModelsApiItem("featherless", {
      id: "example/vision-tool-model",
      context_length: 32_768,
      features: { tool_use: true, image_input: true },
    })).toEqual({
      contextWindow: 32_768,
      inputModalities: ["text", "image"],
      capabilities: ["tool_use", "image_input"],
    });
  });

  test("keeps only plan-available ungated tool rows and preserves native slash ids", async () => {
    globalThis.fetch = (async (input, init) => {
      expectDiscoveryUrl(input);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TEST_KEY}`);
      expect(init?.redirect).toBe("manual");
      return new Response(FEATHERLESS_FIXTURE, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const config = withStubbedProviderFetch(providerConfig());
    const models = (await gatherRoutedModels(config)).filter(row => row.provider === "featherless");
    expect(models.map(row => row.id).sort()).toEqual([
      "alpindale/magnum-72b-v1",
      "example/sparse-plan-tool-model",
      "Qwen/Qwen3-8B",
    ].sort());
    const qwen = models.find(row => row.id === "Qwen/Qwen3-8B");
    const sparse = models.find(row => row.id === "example/sparse-plan-tool-model");
    expect(qwen).toMatchObject({
      owned_by: "Feather",
      contextWindow: 32_768,
      capabilities: ["tool_use"],
      reasoningEfforts: [],
    });
    expect(qwen).not.toHaveProperty("parallelToolCalls");
    expect(sparse).toMatchObject({
      owned_by: "fixture",
      capabilities: ["tool_use"],
      reasoningEfforts: [],
    });
    expect(sparse).not.toHaveProperty("contextWindow");
    expect(sparse).not.toHaveProperty("inputModalities");

    for (const modelId of models.map(row => row.id)) {
      expect(routeModel(config, `featherless/${modelId}`).modelId).toBe(modelId);
      expect(routeModel(config, routedSlug("featherless", modelId)).modelId).toBe(modelId);
    }
  });

  test("routes tool requests without unsupported reasoning or parallel fields", () => {
    const modelId = "Qwen/Qwen3-8B";
    const route = routeModel(providerConfig(), `featherless/${modelId}`);
    const request = createOpenAIChatAdapter(route.provider).buildRequest({
      modelId: route.modelId,
      context: {
        messages: [{ role: "user", content: "ping", timestamp: 0 }],
        tools: [{
          name: "ping",
          description: "Return pong",
          parameters: { type: "object", properties: {} },
        }],
      },
      stream: true,
      options: { reasoning: "high" },
    });
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;

    expect(request.url).toBe(`${BASE_URL}/chat/completions`);
    expect(request.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(body.model).toBe(modelId);
    expect(body).not.toHaveProperty("parallel_tool_calls");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test("serializes a verified Featherless toggle as nested chat-template kwargs", () => {
    const modelId = "deepseek-ai/DeepSeek-V4.1-Flash";
    const config = providerConfig({
      modelReasoningEfforts: { [modelId]: ["none", "high"] },
      modelReasoningEffortMap: { [modelId]: { none: "disabled", high: "enabled" } },
      modelSuppressSyntheticMax: { [modelId]: true },
      preserveReasoningContentModels: [modelId],
    });
    const route = routeModel(config, `featherless/${modelId}`);
    const adapter = createOpenAIChatAdapter(route.provider);
    const parsed = {
      modelId: route.modelId,
      context: { messages: [{ role: "user" as const, content: "ping", timestamp: 0 }], tools: [] },
      stream: true,
      options: { reasoning: "high" },
    };

    const enabled = JSON.parse(String(adapter.buildRequest(parsed).body)) as Record<string, unknown>;
    const disabled = JSON.parse(String(adapter.buildRequest({ ...parsed, options: { reasoning: "none" } }).body)) as Record<string, unknown>;
    expect(enabled.chat_template_kwargs).toEqual({
      enable_thinking: true,
      preserve_thinking: true,
      clear_thinking: false,
    });
    expect(disabled.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(enabled).not.toHaveProperty("reasoning_effort");
    expect(disabled).not.toHaveProperty("reasoning_effort");
  });

  test("keeps an evidence-backed Featherless custom ladder exact in the Codex picker", async () => {
    const modelId = "Qwen/Qwen3.8-27B";
    const config = providerConfig({ liveModels: false });
    config.customModels = [{
      id: "verified",
      provider: "featherless",
      modelId,
      reasoningEfforts: ["none", "high"],
      defaultReasoningEffort: "high",
    }];
    const models = await gatherRoutedModels(config);
    const model = models.find(row => row.provider === "featherless" && row.id === modelId)!;
    const row = buildCatalogEntries(null, [], [model]).find(entry => entry.slug?.startsWith("featherless/"));

    expect(model.preserveExactReasoning).toBe(true);
    expect(row?.supported_reasoning_levels?.map(level => level.effort)).toEqual(["none", "high"]);
    expect(row?.default_reasoning_level).toBe("high");
    // The shortened label is cosmetic: the canonical route remains stable for history/config.
    expect(row?.slug).toBe("featherless/Qwen-Qwen3.8-27B");
    expect(row?.display_name).toBe("fth/Qwen-Qwen3.8-27B");

    // El catálogo nativo de OpenAI normalmente no enumera `none`; aun así Codex lo
    // acepta como sentinela declarado y no debe borrar el apagado verificado de Featherless.
    // El ensamblador real clona las entradas antes del clamp observado. La
    // exactitud debe sobrevivir al clon sin publicar campos privados.
    const cloned = structuredClone(row!);
    clampEntryToCodexSupportedEfforts(cloned, new Set(["low", "medium", "high", "xhigh", "max", "ultra"]));
    expect(cloned.supported_reasoning_levels?.map(level => level.effort)).toEqual(["none", "high"]);
    expect(Object.keys(cloned).some(key => key.includes("exact"))).toBe(false);
  });

  test("publishes provider-declared vision without inferring it from the model name", async () => {
    const config = providerConfig({ liveModels: false });
    config.customModels = [
      {
        id: "vision",
        provider: "featherless",
        modelId: "zai-org/GLM-5.3-Flash",
        inputModalities: ["text", "image"],
      },
      {
        id: "text-only",
        provider: "featherless",
        modelId: "zai-org/GLM-5.3",
        inputModalities: ["text"],
      },
    ];

    const rows = buildCatalogEntries(null, [], await gatherRoutedModels(config));
    const flash = rows.find(row => row.slug === "featherless/zai-org-GLM-5.3-Flash");
    const base = rows.find(row => row.slug === "featherless/zai-org-GLM-5.3");

    expect(flash?.input_modalities).toEqual(["text", "image"]);
    expect(base?.input_modalities).toEqual(["text"]);
    expect(flash?.display_name).toBe("fth/zai-org-GLM-5.3-Flash");
    expect(base?.display_name).toBe("fth/zai-org-GLM-5.3");
  });

  test("does not retarget an older same-named custom provider or adapter", () => {
    const customConfig = providerConfig({ baseUrl: "https://custom.example/v1" });
    const route = routeModel(customConfig, "featherless/custom-model");
    expect(route.provider).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://custom.example/v1",
      authMode: "key",
    });
    expect(resolveProviderModelDiscovery("featherless", customConfig.providers.featherless!).spec).toBeUndefined();
    expect(buildModelsRequest(customConfig.providers.featherless!, "custom-key", "featherless")).toEqual({
      url: "https://custom.example/v1/models",
      headers: { Authorization: "Bearer custom-key" },
    });

    const nearMissConfig = providerConfig({ baseUrl: "https://api.featherless.ai/v2" });
    expect(
      resolveProviderModelDiscovery("featherless", nearMissConfig.providers.featherless!).spec,
    ).toBeUndefined();

    const customAdapter = routeModel(providerConfig({
      adapter: "anthropic",
      baseUrl: "https://custom.example/anthropic",
    }), "featherless/custom-model");
    expect(customAdapter.provider).toMatchObject({
      adapter: "anthropic",
      baseUrl: "https://custom.example/anthropic",
      authMode: "key",
    });
  });
});
