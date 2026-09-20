import { describe, expect, test } from "bun:test";
import { classifyFeatherlessModel, featherlessSearchUrl, isFeatherlessCatalogProvider } from "../../src/providers/featherless-catalog";

describe("Política transversal del catálogo Featherless", () => {
  const row = (id: string, size?: number, tags?: Record<string, string[]>) => classifyFeatherlessModel({ id, parameter_size: size, classified_tags: tags });
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
    expect(() => featherlessSearchUrl(new URLSearchParams("page=-1"))).toThrow();
    expect(() => featherlessSearchUrl(new URLSearchParams("sort=anything"))).toThrow();
  });
  test("no cambia un proveedor retargeteado", () => {
    expect(isFeatherlessCatalogProvider({ adapter: "openai-chat", baseUrl: "https://api.featherless.ai/v1/" })).toBe(true);
    expect(isFeatherlessCatalogProvider({ adapter: "openai-chat", baseUrl: "https://custom.example/v1" })).toBe(false);
  });
});
