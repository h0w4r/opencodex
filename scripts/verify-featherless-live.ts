/** Comprobación pública real; no lee credenciales ni realiza inferencias facturables. */
import { mkdirSync, writeFileSync } from "node:fs";
import { fetchFeatherlessPage, warmFeatherlessIndex } from "../src/providers/featherless-index";
const evidence: unknown[] = [];
const queries = ["", "page=2", "query=abliterated", "domains=cybersecurity", "sort=-parameter_size", "training=uncensored", "query=Qwen/Qwen3.8-27B"];
for (const query of queries) {
  const start = Date.now();
  console.log(JSON.stringify({ phase: "preparando-indice-admitido", query }));
  const heartbeat = setInterval(() => console.log(JSON.stringify({ phase: "indice-en-progreso", query, elapsedSeconds: Math.round((Date.now() - start) / 1000) })), 15000);
  try { await warmFeatherlessIndex(new URLSearchParams(query)); } finally { clearInterval(heartbeat); }
  const page = await fetchFeatherlessPage(new URLSearchParams(query));
  if (page.items.some(row => row.reason !== "exception" && (row.parameterSize === null || row.parameterSize < 16e9))) throw new Error("Violación de la política.");
  if (page.items.some(row => row.toolUse !== true)) throw new Error("Se admitió un modelo sin tool calling publicado.");
  const result = { query, ms: Date.now() - start, catalog: page.catalog, pagination: page.pagination, shown: page.items.length, excluded: page.excluded, unknown: page.unknown,
    facets: Object.keys(page.facets), sample: page.items.slice(0, 3).map(m => ({ id: m.id, size: m.parameterSize, reason: m.reason, evidence: m.evidence })) };
  evidence.push(result); console.log(JSON.stringify(result));
}
mkdirSync(".tmp/featherless-evidence", { recursive: true });
writeFileSync(".tmp/featherless-evidence/public-api.json", JSON.stringify({ at: new Date().toISOString(), evidence }, null, 2));
