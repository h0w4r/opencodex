/** Comprobación pública real; no lee credenciales ni realiza inferencias facturables. */
import { mkdirSync, writeFileSync } from "node:fs";
import { fetchFeatherlessPage } from "../src/providers/featherless-catalog";
const evidence: unknown[] = [];
const queries = ["", "page=2", "query=abliterated", "domains=cybersecurity", "sort=-parameter_size", "training=uncensored", "query=Qwen/Qwen3.8-27B"];
for (const query of queries) {
  const start = Date.now();
  const page = await fetchFeatherlessPage(new URLSearchParams(query));
  if (page.items.some(row => row.reason !== "exception" && (row.parameterSize === null || row.parameterSize < 16e9))) throw new Error("Violación de la política.");
  const result = { query, ms: Date.now() - start, pagination: page.pagination, shown: page.items.length, excluded: page.excluded, unknown: page.unknown,
    facets: Object.keys(page.facets), sample: page.items.slice(0, 3).map(m => ({ id: m.id, size: m.parameterSize, reason: m.reason, evidence: m.evidence })) };
  evidence.push(result); console.log(JSON.stringify(result));
}
mkdirSync(".tmp/featherless-evidence", { recursive: true });
writeFileSync(".tmp/featherless-evidence/public-api.json", JSON.stringify({ at: new Date().toISOString(), evidence }, null, 2));
