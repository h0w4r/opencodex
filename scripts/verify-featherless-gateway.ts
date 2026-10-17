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
let catalog: Response;
// Preparación inicial con progreso real: sin cancelar una indexación activa por duración total.
for (;;) {
  catalog = await fetch(`${base}/api/featherless/models?page=2`, { headers });
  if (catalog.status !== 202) break;
  console.log(JSON.stringify({ phase: "indexing", ...(await catalog.json() as object) }));
  await Bun.sleep(1500);
}
if (!catalog.ok) throw new Error(`Catálogo: HTTP ${catalog.status}`);
const page = await catalog.json() as { pagination: { current_page: number; total_items: number }; items: Array<{ toolUse: boolean | null }> };
if (page.pagination.current_page !== 2 || page.pagination.total_items <= 100) throw new Error("Catálogo recortado.");
if (page.items.some(item => item.toolUse !== true)) throw new Error("El catálogo admitió modelos sin herramientas.");
if (page.items.length !== 100) throw new Error("La paginación se está realizando antes de aplicar restricciones.");
results.catalog = { ...page.pagination, eligibleOnPage: page.items.length };
const choose = (id: string) => fetch(`${base}/api/featherless/selection`, { method: "POST", headers, body: JSON.stringify({ provider: "featherless", id, enabled: true }) });
const denied = await choose("Qwen/Qwen3-0.6B");
if (denied.status !== 422) throw new Error(`No se rechazó el modelo pequeño: ${denied.status}`);
results.excludedHttpStatus = denied.status;
// Este modelo cumple el tamaño, pero el proveedor no publica tool calling para él.
const noTools = await choose("google/gemma-3-27b-it");
if (noTools.status !== 422) throw new Error(`No se rechazó el modelo sin herramientas: ${noTools.status}`);
results.noToolsHttpStatus = noTools.status;
const selected = await choose(model);
if (!selected.ok) throw new Error(`Selección real: HTTP ${selected.status}`);
const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
const savedModel = saved.customModels?.find((row: { provider: string; modelId: string }) => row.provider === "featherless" && row.modelId === model);
if (!savedModel) throw new Error("No se persistió el modelo.");
if (!savedModel.inputModalities?.includes("image")) throw new Error("La selección perdió la modalidad de imagen declarada por Featherless.");
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
// Circuito visual real: la imagen binaria viaja por el gateway hasta Featherless.
// Una etiqueta de catálogo sin este recorrido no acredita que el transporte acepte imágenes.
const visionBytes = readFileSync(resolve("tests/fixtures/featherless-vision-red-blue.png"));
const visionResponse = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers,
  body: JSON.stringify({
    model: routedSlug("featherless", model),
    messages: [{ role: "user", content: [
      { type: "text", text: "Identify the two solid color blocks. Reply exactly: RED LEFT, BLUE RIGHT" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${visionBytes.toString("base64")}` } },
    ] }],
    max_tokens: 128,
    stream: false,
  }) });
if (!visionResponse.ok) throw new Error(`Visión real: HTTP ${visionResponse.status}`);
const visionOutput = await visionResponse.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
const visionContent = visionOutput.choices?.[0]?.message?.content?.trim() ?? "";
if (!/RED\s+LEFT[\s,;:-]+BLUE\s+RIGHT/i.test(visionContent)) throw new Error(`La respuesta visual no identificó los bloques: ${visionContent.slice(0, 160)}`);
results.vision = { model, inputModalities: savedModel.inputModalities, resultMatched: true, content: visionContent, usage: visionOutput.usage };
// Circuito real de herramientas: el modelo debe pedir una lectura; el runner lee
// un archivo recién creado y devuelve el resultado mediante el protocolo tool.
const marker = crypto.randomUUID();
const artifact = join(home, "tool-validation.txt");
writeFileSync(artifact, marker);
const messages: Array<Record<string, unknown>> = [{ role: "user", content: "Lee el artefacto de validación con read_validation_artifact y devuelve exactamente su contenido. No lo adivines." }];
const tools = [{ type: "function", function: { name: "read_validation_artifact", description: "Lee el archivo local de validación y devuelve su contenido actual.", parameters: { type: "object", properties: {}, additionalProperties: false } } }];
async function chat(turns: Array<Record<string, unknown>>, toolChoice: string) {
  const response = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers,
    body: JSON.stringify({ model: routedSlug("featherless", model), messages: turns, tools, tool_choice: toolChoice, max_tokens: 2048, stream: false }) });
  if (!response.ok) throw new Error(`Circuito real de herramientas: HTTP ${response.status}`);
  return await response.json() as { choices?: Array<{ message?: Record<string, unknown> & { content?: string; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> } }>; usage?: unknown };
}
const first = await chat(messages, "required");
const assistant = first.choices?.[0]?.message;
if (!assistant?.tool_calls?.length) throw new Error("El modelo no produjo tool_calls estructurados.");
messages.push(assistant);
for (const call of assistant.tool_calls) {
  if (call.type !== "function" || call.function.name !== "read_validation_artifact" || Object.keys(JSON.parse(call.function.arguments)).length) throw new Error("Llamada de herramienta inválida.");
  // No se ejecuta código propuesto por el modelo; sólo la lectura concreta autorizada.
  messages.push({ role: "tool", tool_call_id: call.id, content: readFileSync(artifact, "utf8") });
}
const second = await chat(messages, "none");
if (!second.choices?.[0]?.message?.content?.includes(marker)) throw new Error("El modelo no incorporó el resultado real de la herramienta.");
results.toolCalling = { model, calls: assistant.tool_calls.length, tool: "read_validation_artifact", persistedRead: true, resultMatched: true, firstUsage: first.usage, secondUsage: second.usage };
const evidence = resolve(process.env.FEATHERLESS_VERIFY_EVIDENCE ?? ".tmp/featherless-evidence/gateway.json");
mkdirSync(resolve(evidence, ".."), { recursive: true });
writeFileSync(evidence, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ passed: true, evidence, ...results }, null, 2));
