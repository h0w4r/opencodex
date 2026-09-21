import { describe, expect, test } from "bun:test";
import { classifyFeatherlessModel, featherlessSearchUrl, featherlessSourceUrl, fetchFeatherlessWithRetry, isFeatherlessCatalogProvider } from "../../src/providers/featherless-catalog";

describe("Política transversal del catálogo Featherless", () => {
  test("restricciones en origen no amplían excepciones con un OR de toda la faceta tools", () => {
    const source = featherlessSourceUrl(new URLSearchParams("capabilities=red-teaming"));
    expect(source.searchParams.getAll("capabilities")).toEqual(["red-teaming"]);
    expect(source.searchParams.get("supports_tool_calling")).toBe("true");
    expect(featherlessSourceUrl(new URLSearchParams(), { min: 16 }).searchParams.get("parameter_size_min")).toBe("16");
  });
  const row = (id: string, size?: number, tags?: Record<string, string[]>) => classifyFeatherlessModel({ id, parameter_size: size, classified_tags: tags, supports_tool_calling: true });
  test("herramientas es un requisito independiente del tamaño y de las excepciones", () => {
    for (const id of ["org/normal-70B", "org/abliterated-70B", "org/cybersecurity-4B"]) {
      expect(classifyFeatherlessModel({ id, parameter_size: 70e9, supports_tool_calling: false }).reason).toBe("tools-unsupported");
      expect(classifyFeatherlessModel({ id, parameter_size: 70e9 }).reason).toBe("tools-unverified");
    }
    expect(classifyFeatherlessModel({ id: "org/agent-instruct-tools", parameter_size: 70e9, classified_tags: { capabilities: ["agent", "tool-use"] } }).reason).toBe("tools-unverified");
  });
  test("acepta flags publicados, no booleanos textuales ni contradicciones", () => {
    const model = { id: "org/model", parameter_size: 70e9 };
    expect(classifyFeatherlessModel({ ...model, features: { tool_use: true } }).reason).toBe("parameters");
    expect(classifyFeatherlessModel({ ...model, supports_tool_calling: "true" }).reason).toBe("tools-unverified");
    expect(classifyFeatherlessModel({ ...model, supports_tool_calling: true, features: { tool_use: false } }).reason).toBe("tools-unsupported");
    expect(classifyFeatherlessModel({ ...model, supports_tool_calling: false, features: { tool_use: true } }).toolUse).toBe(false);
    expect(classifyFeatherlessModel({ ...model, features: { tool_use: true } }).toolEvidence).toEqual(["features.tool_use:true"]);
  });
  test("el límite de 16B es inclusivo y no se deduce del nombre", () => {
    expect(row("org/model", 16e9).reason).toBe("parameters");
    expect(row("org/model", 16e9 - 1).reason).toBe("excluded");
    expect(row("org/70B").reason).toBe("unknown");
    expect(row("org/30B-A3B", 30e9).reason).toBe("parameters");
  });
  test("las excepciones son trazables sin confundir autor con especialización", () => {
    for (const name of ["uncensored", "abliterated", "obliterated", "de-aligned", "refusal-removed", "cybersecurity", "pentesting"]) {
      const result = row(`org/model-0.6B-${name}`, 0.6e9);
      expect(result.reason).toBe("exception"); expect(result.evidence.length).toBeGreaterThan(0);
    }
    expect(row("uncensored-org/ordinary-8B", 8e9).reason).toBe("excluded");
    expect(row("org/special", 1e9, { domains: ["security"] }).reason).toBe("exception");
    expect(row("org/ordinary", 1e9, { license: ["security"] }).reason).toBe("excluded");
    expect(row("org/ordinary", 1e9, { license: ["unrestricted"] }).reason).toBe("excluded");
    expect(row("org/ordinary", 1e9, { family: ["uncensored"] }).reason).toBe("excluded");
    expect(row("org/mystery", undefined, { training: ["abliterated"] }).reason).toBe("exception");
  });
  test("conserva paginación arbitraria y filtros múltiples sin abrir destinos arbitrarios", () => {
    const result = featherlessSearchUrl(new URLSearchParams("page=9999&family=qwen3&family=llama3&sort=-avg_rating&baseUrl=https://invalid.test"));
    expect(result.origin).toBe("https://api.featherless.ai");
    expect(result.searchParams.get("page")).toBe("9999");
    expect(result.searchParams.getAll("family")).toEqual(["llama3", "qwen3"]);
    expect(result.searchParams.has("baseUrl")).toBe(false);
    expect(result.searchParams.getAll("capabilities")).toEqual(["tool-use"]);
    expect(featherlessSearchUrl(new URLSearchParams("capabilities=chat&capabilities=tool-use&tools=false")).searchParams.getAll("capabilities")).toEqual(["chat", "tool-use"]);
    expect(() => featherlessSearchUrl(new URLSearchParams("page=-1"))).toThrow();
    expect(() => featherlessSearchUrl(new URLSearchParams("sort=anything"))).toThrow();
  });
  test("no cambia un proveedor retargeteado", () => {
    expect(isFeatherlessCatalogProvider({ adapter: "openai-chat", baseUrl: "https://api.featherless.ai/v1/" })).toBe(true);
    expect(isFeatherlessCatalogProvider({ adapter: "openai-chat", baseUrl: "https://custom.example/v1" })).toBe(false);
  });
  test("reintenta errores transitorios sin ocultar un fallo definitivo", async () => {
    const statuses = [502, 429, 200];
    const delays: number[] = [];
    const recovered = await fetchFeatherlessWithRetry("https://api.featherless.ai/example", {}, {
      fetch: (async () => new Response("{}", { status: statuses.shift()!, headers: { "retry-after": "0" } })) as typeof fetch,
      sleep: async milliseconds => { delays.push(milliseconds); },
    });
    expect(recovered.status).toBe(200);
    expect(delays).toEqual([0, 0]);

    let calls = 0;
    const rejected = await fetchFeatherlessWithRetry("https://api.featherless.ai/example", {}, {
      fetch: (async () => { calls++; return new Response("bad request", { status: 400 }); }) as typeof fetch,
      sleep: async () => { throw new Error("No debe esperar ante un error definitivo."); },
    });
    expect(rejected.status).toBe(400);
    expect(calls).toBe(1);
  });
});
