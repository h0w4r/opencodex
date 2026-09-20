import { describe, expect, test } from "bun:test";
import { applyFeatherlessToolProof, classifyFeatherlessModel } from "../../src/providers/featherless-catalog";
import { fingerprintFeatherlessCapabilityEvidence, parseFeatherlessCapabilityEvidence } from "../../src/providers/featherless-capability-evidence";

const NOW = Date.parse("2026-09-20T20:00:00.000Z");

function file(proofs: unknown[]) {
  return {
    schemaVersion: 1,
    providerBaseUrl: "https://api.featherless.ai/v1",
    generatedAt: "2026-09-20T19:30:00.000Z",
    proofs,
  };
}

function proof(overrides: Record<string, unknown> = {}) {
  return {
    modelId: "deepseek-ai/DeepSeek-V4.1-Flash",
    capability: "tool-calling",
    status: "verified",
    transport: "openai-chat-stream",
    observedAt: "2026-09-20T19:00:00.000Z",
    expiresAt: "2026-10-20T19:00:00.000Z",
    probeVersion: "tool-roundtrip-v1",
    resultSha256: "a".repeat(64),
    ...overrides,
  };
}

describe("Evidencia runtime de capacidades Featherless", () => {
  test("acepta únicamente pruebas vigentes del proveedor y transporte oficiales", () => {
    expect(parseFeatherlessCapabilityEvidence(file([proof()]), NOW).size).toBe(1);
    expect(parseFeatherlessCapabilityEvidence({ ...file([proof()]), providerBaseUrl: "https://example.test/v1" }, NOW).size).toBe(0);
    expect(parseFeatherlessCapabilityEvidence(file([proof({ expiresAt: "2026-09-20T19:59:59.000Z" })]), NOW).size).toBe(0);
    expect(parseFeatherlessCapabilityEvidence(file([proof({ resultSha256: "not-a-digest" })]), NOW).size).toBe(0);
    expect(parseFeatherlessCapabilityEvidence(file([proof({ expiresAt: "2027-09-20T19:00:00.000Z" })]), NOW).size).toBe(0);
  });

  test("deduplica por ID conservando la observación válida más reciente", () => {
    const old = proof({ observedAt: "2026-09-19T19:00:00.000Z", resultSha256: "b".repeat(64) });
    const current = proof();
    expect(parseFeatherlessCapabilityEvidence(file([current, old]), NOW).get(current.modelId)?.resultSha256).toBe("a".repeat(64));
  });

  test("el fingerprint cambia con pruebas efectivas, no con el orden del archivo", () => {
    const first = parseFeatherlessCapabilityEvidence(file([proof(), proof({ modelId: "org/second", resultSha256: "b".repeat(64) })]), NOW);
    const reversed = parseFeatherlessCapabilityEvidence(file([...first.values()].reverse()), NOW);
    expect(fingerprintFeatherlessCapabilityEvidence(first)).toBe(fingerprintFeatherlessCapabilityEvidence(reversed));
    const changed = new Map(first);
    changed.set("org/second", { ...changed.get("org/second")!, resultSha256: "c".repeat(64) });
    expect(fingerprintFeatherlessCapabilityEvidence(changed)).not.toBe(fingerprintFeatherlessCapabilityEvidence(first));
  });

  test("corrige el falso negativo de tools sin eludir la restricción de parámetros", () => {
    const large = classifyFeatherlessModel({ id: "org/large", parameter_size: 70e9, supports_tool_calling: false });
    const small = classifyFeatherlessModel({ id: "org/small", parameter_size: 8e9, supports_tool_calling: false });
    const admitted = applyFeatherlessToolProof(large, "runtime:openai-chat-stream:test");
    expect(admitted.toolUse).toBe(true);
    expect(admitted.reason).toBe("parameters");
    expect(admitted.toolEvidence.at(-1)).toStartWith("runtime:");
    expect(applyFeatherlessToolProof(small, "runtime:test").reason).toBe("excluded");
  });
});
