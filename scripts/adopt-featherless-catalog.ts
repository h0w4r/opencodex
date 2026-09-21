/** Adopción explícita: modifica sólo el modo de descubrimiento del proveedor oficial, usando el writer upstream. */
import { loadConfig, saveConfigPreservingClaudeCode } from "../src/config";
import {
  applyFeatherlessToolProof,
  classifyFeatherlessModel,
  isFeatherlessCatalogProvider,
} from "../src/providers/featherless-catalog";
import { loadFeatherlessCapabilityEvidence } from "../src/providers/featherless-capability-evidence";
import { routedSlug, slugEquals } from "../src/providers/slug-codec";
let config = loadConfig();
const names: string[] = [];
const rejected: Array<{ provider: string; id: string; reason: string }> = [];
// La adopción debe usar la misma política que el índice. Ignorar una prueba runtime
// vigente volvería a deshabilitar justamente los modelos acreditados por tool calling real.
const toolProofs = loadFeatherlessCapabilityEvidence();
// Primero verifica todo, después escribe: una caída de red no deja una migración parcial.
for (const [name, provider] of Object.entries(config.providers)) {
  if (!isFeatherlessCatalogProvider(provider)) continue;
  names.push(name);
  const ids = new Set([...(provider.models ?? []), ...(provider.selectedModels ?? []),
    ...(config.customModels ?? []).filter(m => m.provider === name).map(m => m.modelId)]);
  for (const id of ids) {
    if (config.disabledModels?.some(slug => slugEquals(slug, name, id))) continue;
    const response = await fetch(`https://api.featherless.ai/v1/models/${id.split("/").map(encodeURIComponent).join("/")}`,
      { redirect: "error", signal: AbortSignal.timeout(30000) });
    if (response.status === 404) { rejected.push({ provider: name, id, reason: "not-found" }); continue; }
    if (!response.ok) throw new Error(`No se modificó la selección: metadatos HTTP ${response.status}.`);
    let model = classifyFeatherlessModel(await response.json());
    const proof = toolProofs.get(id);
    if (proof) model = applyFeatherlessToolProof(model, `runtime:${proof.transport}:${proof.observedAt}`);
    if (model.id !== id) throw new Error("No se modificó la selección: identificador remoto inconsistente.");
    if (model.reason !== "parameters" && model.reason !== "exception") rejected.push({ provider: name, id, reason: model.reason });
  }
}
// Relee antes de guardar para conservar configuraciones editadas durante las consultas.
config = loadConfig();
for (const name of names) if (config.providers[name] && isFeatherlessCatalogProvider(config.providers[name])) config.providers[name].liveModels = false;
for (const row of rejected) {
  if (!config.providers[row.provider] || !isFeatherlessCatalogProvider(config.providers[row.provider])) continue;
  config.disabledModels = [...new Set([...(config.disabledModels ?? []), routedSlug(row.provider, row.id)])];
}
saveConfigPreservingClaudeCode(config);
console.log(JSON.stringify({ adaptedProviders: names, disabledByPolicy: rejected, credentialsChanged: false }));
