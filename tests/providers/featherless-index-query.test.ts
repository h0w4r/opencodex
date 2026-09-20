import { describe, expect, test } from "bun:test";
import { classifyFeatherlessModel } from "../../src/providers/featherless-catalog";
import { parameterBucket, queryFeatherlessIndex } from "../../src/providers/featherless-index-query";

describe("Índice admitido antes de filtros opcionales", () => {
  // Datos unitarios: no sustituyen las pruebas reales del gateway y del navegador.
  const models = Array.from({ length: 153 }, (_, i) => classifyFeatherlessModel({ id: `org/model-${i}`,
    supports_tool_calling: true, parameter_size: 16e9 + i, downloads: i + 1,
    family: i % 2 ? "a" : "b", classified_tags: { modalities: ["text"], capabilities: ["tool-use"] } }));
  test("cuenta, pagina y ordena sólo el índice admitido", () => {
    const page1 = queryFeatherlessIndex(models, new URLSearchParams());
    const page2 = queryFeatherlessIndex(models, new URLSearchParams("page=2"));
    expect(page1.pagination.total_items).toBe(153);
    expect(page1.pagination.total_pages).toBe(2);
    expect(page1.items).toHaveLength(100);
    expect(page2.items).toHaveLength(53);
    expect(page1.items[0].downloads).toBe(153);
    expect(new Set([...page1.items, ...page2.items].map(m => m.id)).size).toBe(153);
    expect(page1.facets.modalities).toEqual([{ value: "text", count: 153 }]);
  });
  test("los filtros de navegación no amplían el universo ni conservan contadores remotos", () => {
    const filtered = queryFeatherlessIndex(models, new URLSearchParams("family=a"));
    expect(filtered.pagination.total_items).toBe(76);
    expect(filtered.facets.modalities[0].count).toBe(76);
    expect(filtered.items.every(m => m.tags.family.includes("a"))).toBe(true);
    expect(queryFeatherlessIndex(models, new URLSearchParams("query=absent")).pagination.total_items).toBe(0);
    expect(queryFeatherlessIndex(models, new URLSearchParams("family=a&family=b")).pagination.total_items).toBe(153);
  });
  test("intervalos usan parámetros totales, incluidos límites B y T", () => {
    const buckets = ["< 1B", "1B", "10-15B", "16-27B", "28-40B", "1T+", "1T"];
    expect(parameterBucket(0.6e9, buckets)).toEqual(["< 1B"]);
    expect(parameterBucket(16e9, buckets)).toEqual(["16-27B"]);
    expect(parameterBucket(1e12, buckets)).toEqual(["1T"]);
    expect(parameterBucket(2.78e12, buckets)).toEqual(["1T+"]);
    expect(parameterBucket(null, buckets)).toEqual([]);
  });
});
