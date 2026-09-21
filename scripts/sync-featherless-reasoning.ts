#!/usr/bin/env bun
/**
 * Revalida los modelos Featherless ya seleccionados y sincroniza sus niveles reales.
 *
 * Uso:
 *   bun scripts/sync-featherless-reasoning.ts          # diagnóstico sin escritura
 *   bun scripts/sync-featherless-reasoning.ts --apply  # guarda config.json de forma atómica
 */
import { loadConfig, saveConfigPreservingClaudeCode } from "../src/config";
import { resolveModelsAuthToken } from "../src/oauth";
import { isFeatherlessCatalogProvider } from "../src/providers/featherless-catalog";
import {
  applyFeatherlessReasoningProfile,
  probeFeatherlessReasoningProfile,
} from "../src/providers/featherless-reasoning";

const apply = process.argv.includes("--apply");
const config = loadConfig();
let inspected = 0;
let toggles = 0;
let budgets = 0;
let fixedOrUnknown = 0;

for (const [providerName, provider] of Object.entries(config.providers)) {
  if (!isFeatherlessCatalogProvider(provider)) continue;
  const token = await resolveModelsAuthToken(providerName, provider);
  if (!token) throw new Error(`El proveedor ${providerName} no tiene una credencial resoluble.`);
  const models = (config.customModels ?? []).filter(model => model.provider === providerName);
  for (const model of models) {
    const profile = await probeFeatherlessReasoningProfile(model.modelId, token);
    inspected++;
    if (profile.kind === "toggle") toggles++;
    else if (profile.kind === "budget") budgets++;
    else fixedOrUnknown++;
    if (apply) applyFeatherlessReasoningProfile(provider, model, profile);
    console.log(
      `[${inspected}/${models.length}] ${model.modelId}: ${profile.kind}`
      + (profile.reasoningEfforts.length > 0 ? ` (${profile.reasoningEfforts.join(",")})` : ""),
    );
  }
}

if (apply) saveConfigPreservingClaudeCode(config);
console.log(JSON.stringify({ apply, inspected, toggles, budgets, fixedOrUnknown }));
