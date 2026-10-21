import { describe, expect, test } from "bun:test";
import { applyClaudeExternalEffort, claudeExternalEffortDecision, externalEffortKey } from "../../src/claude/external-effort";
import { parseRequest } from "../../src/responses/parser";
import { prepareEffortNormalization } from "../../src/server/effort-policy";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const provider = { adapter: "openai-chat", baseUrl: "https://provider.example/v1", models: ["org/model"], modelReasoningEfforts: { "org/model": ["none", "low", "high", "max"] } } as OcxProviderConfig;
const route = { providerName: "external", modelId: "org/model", provider };
const config = { port: 10100, providers: { external: provider }, claudeExternalEfforts: { [externalEffortKey("external", "org/model")]: "max" } } as OcxConfig;

describe("selector explícito de esfuerzo para Claude externo", () => {
  test("sin selección propia rechaza un nivel no declarado del cliente", () => {
    const parsed = parseRequest({ model: "x", input: "prueba", reasoning: { effort: "medium" } });
    expect(claudeExternalEffortDecision({ ...config, claudeExternalEfforts: {} }, route, "anthropic", parsed).code).toBe("external_effort_invalid");
  });
  test("una edición no cambia el esfuerzo de una petición ya iniciada", () => {
    const parsed = parseRequest({ model: "x", input: "prueba" });
    const local = structuredClone(config);
    expect(claudeExternalEffortDecision(local, route, "anthropic", parsed).effort).toBe("max");
    local.claudeExternalEfforts!["external/org/model"] = "low";
    expect(applyClaudeExternalEffort(parsed, local, route, "anthropic")).toBe("max");
    expect(applyClaudeExternalEffort(parseRequest({ model: "x", input: "nuevo" }), local, route, "anthropic")).toBe("low");
  });
  test("aplica un nivel exacto y preserva mensajes, tokens y summary", () => {
    const parsed = parseRequest({ model: "external/org/model", input: "prueba", max_output_tokens: 1234, reasoning: { effort: "medium", summary: "auto" } });
    expect(applyClaudeExternalEffort(parsed, config, route, "anthropic")).toBe("max");
    expect(parsed.options.reasoning).toBe("max");
    expect((parsed._rawBody as any).reasoning).toEqual({ effort: "max", summary: "auto" });
    expect((parsed._rawBody as any).max_output_tokens).toBe(1234);
  });
  test("OFF se conserva como none explícito, no como predeterminado", () => {
    const parsed = parseRequest({ model: "x", input: "prueba" });
    applyClaudeExternalEffort(parsed, { ...config, claudeExternalEfforts: { "external/org/model": "none" } }, route, "anthropic");
    expect(parsed.options.reasoning).toBe("none");
    expect((parsed._rawBody as any).reasoning.effort).toBe("none");
  });
  test("rechaza niveles discontinuos ausentes y desconocidos", () => {
    expect(claudeExternalEffortDecision({ ...config, claudeExternalEfforts: { "external/org/model": "medium" } }, route, "anthropic").error).toBeDefined();
    expect(claudeExternalEffortDecision(config, { ...route, provider: { ...provider, modelReasoningEfforts: { "org/model": [] } } }, "anthropic").error).toBeDefined();
  });
  test("no altera OMP/chat, Codex/responses ni Anthropic nativo", () => {
    for (const wire of ["chat", "responses"]) expect(claudeExternalEffortDecision(config, route, wire)).toEqual({});
    expect(claudeExternalEffortDecision(config, { ...route, providerName: "anthropic" }, "anthropic")).toEqual({});
  });
  test("la recuperación de otra ruta restaura la petición original", () => {
    const parsed = parseRequest({ model: "external/org/model", input: "prueba", reasoning: { effort: "low" } });
    prepareEffortNormalization(parsed, route);
    applyClaudeExternalEffort(parsed, config, route, "anthropic");
    prepareEffortNormalization(parsed, { providerName: "other", modelId: "different" });
    expect(parsed.options.reasoning).toBe("low");
  });
});
