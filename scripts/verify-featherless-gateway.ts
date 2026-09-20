/** Acreditación real: catálogo, política, selección durable y una inferencia mínima, sin dobles de prueba. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { routedSlug } from "../src/providers/slug-codec";
const base = process.env.FEATHERLESS_VERIFY_URL ?? "http://127.0.0.1:10101";
const home = process.env.FEATHERLESS_VERIFY_HOME ?? resolve(".tmp/featherless-live-home");
const model = process.env.FEATHERLESS_VERIFY_MODEL ?? "Qwen/Qwen3.8-27B";
const token = readFileSync(join(home, "admin-api-token"), "utf8").trim();
const headers = { "x-opencodex-api-key": token, "Content-Type": "application/json" };
const results: Record<string, unknown> = { date: new Date().toISOString(), base, model };
const catalog = await fetch(`${base}/api/featherless/models?page=2`, { headers });
if (!catalog.ok) throw new Error(`Catálogo: HTTP ${catalog.status}`);
const page = await catalog.json() as { pagination: { current_page: number; total_items: number }; items: unknown[] };
if (page.pagination.current_page !== 2 || page.pagination.total_items <= 100) throw new Error("Catálogo recortado.");
results.catalog = { ...page.pagination, eligibleOnPage: page.items.length };
const choose = (id: string) => fetch(`${base}/api/featherless/selection`, { method: "POST", headers, body: JSON.stringify({ provider: "featherless", id, enabled: true }) });
const denied = await choose("Qwen/Qwen3-0.6B");
if (denied.status !== 422) throw new Error(`No se rechazó el modelo pequeño: ${denied.status}`);
results.excludedHttpStatus = denied.status;
const selected = await choose(model);
if (!selected.ok) throw new Error(`Selección real: HTTP ${selected.status}`);
const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
if (!saved.customModels?.some((row: { provider: string; modelId: string }) => row.provider === "featherless" && row.modelId === model)) throw new Error("No se persistió el modelo.");
if (saved.providers.featherless.liveModels !== false) throw new Error("No se separó descubrimiento de habilitación.");
// Sin timeout total para una inferencia viva. El transporte del proveedor administra sus límites propios.
const response = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers,
  body: JSON.stringify({ model: routedSlug("featherless", model), messages: [{ role: "user", content: "Responde únicamente OK." }], max_tokens: 64, stream: false }) });
if (!response.ok) throw new Error(`Inferencia real: HTTP ${response.status}`);
const output = await response.json() as { model?: string; choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: unknown };
const content = output.choices?.[0]?.message?.content;
if (!content?.includes("OK")) throw new Error("La inferencia real no devolvió la salida esperada.");
results.inference = { model: output.model, content: content.trim(), finishReason: output.choices?.[0]?.finish_reason, usage: output.usage };
results.persisted = true;
const evidence = resolve(process.env.FEATHERLESS_VERIFY_EVIDENCE ?? ".tmp/featherless-evidence/gateway.json");
mkdirSync(resolve(evidence, ".."), { recursive: true });
writeFileSync(evidence, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ passed: true, evidence, ...results }, null, 2));
