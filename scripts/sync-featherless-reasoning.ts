#!/usr/bin/env bun
/**
 * Revalida los modelos Featherless ya seleccionados y sincroniza sus niveles reales.
 *
 * Uso:
 *   bun scripts/sync-featherless-reasoning.ts          # diagnóstico sin escritura
 *   bun scripts/sync-featherless-reasoning.ts --apply  # guarda config.json de forma atómica
 *   bun scripts/sync-featherless-reasoning.ts --report <archivo> # evidencia sanitizada
 */
import { armDetachedConfigBaseline, loadConfig, saveConfigPreservingClaudeCode } from "../src/config";
import { resolveModelsAuthToken } from "../src/oauth";
import { isFeatherlessCatalogProvider } from "../src/providers/featherless-catalog";
import { slugEquals } from "../src/providers/slug-codec";
import { fetchFeatherlessModelLimits, applyFeatherlessModelLimits } from "../src/providers/featherless-model-limits";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  applyFeatherlessReasoningProfile,
  probeFeatherlessReasoningProfile,
} from "../src/providers/featherless-reasoning";

const apply = process.argv.includes("--apply");
const limitsOnly = process.argv.includes("--limits-only");
const reportIndex = process.argv.indexOf("--report");
if (reportIndex >= 0 && (!process.argv[reportIndex + 1] || process.argv[reportIndex + 1]!.startsWith("--"))) {
  throw new Error("--report requiere una ruta de archivo.");
}
const reportPath = reportIndex < 0 ? undefined : resolve(process.argv[reportIndex + 1]!);
const evidence: Record<string, unknown>[] = [];
const config = loadConfig();
// Conservar ediciones concurrentes durante las consultas remotas.
armDetachedConfigBaseline(config);
let inspected = 0;
let outputLimitsKnown = 0;
let limitFetchFailures = 0;
let toggles = 0;
let budgets = 0;
let namedEfforts = 0;
let fixedOrUnknown = 0;
let inconclusivePreserved = 0;

for (const [providerName, provider] of Object.entries(config.providers)) {
  if (!isFeatherlessCatalogProvider(provider)) continue;
  const token = await resolveModelsAuthToken(providerName, provider);
  if (!token) throw new Error(`El proveedor ${providerName} no tiene una credencial resoluble.`);
  const models = (config.customModels ?? []).filter(model => model.provider === providerName);
  for (const model of models) {
    const limits = await fetchFeatherlessModelLimits(model.modelId, token);
    if (limits.maxOutputTokens !== undefined) outputLimitsKnown++;
    if (limits.status !== 200 || limits.contextWindow === undefined) limitFetchFailures++;
    if (apply) applyFeatherlessModelLimits(provider, model, limits);
    if (limitsOnly) {
      inspected++;
      evidence.push({ provider: providerName, modelId: model.modelId, limits });
      console.log(`[${inspected}/${models.length}] ${model.modelId}: límites HTTP ${limits.status}`);
      continue;
    }
    const profile = await probeFeatherlessReasoningProfile(model.modelId, token);
    inspected++;
    if (!profile.complete) inconclusivePreserved++;
    else if (profile.kind === "toggle") toggles++;
    else if (profile.kind === "budget") budgets++;
    else if (profile.kind === "effort") namedEfforts++;
    else fixedOrUnknown++;
    if (apply) applyFeatherlessReasoningProfile(provider, model, profile);
    // Evidencia pública de controles, nunca API keys ni contenido del system prompt.
    evidence.push({ provider: providerName, modelId: model.modelId,
      selected: !(config.disabledModels ?? []).some(slug => slugEquals(slug, providerName, model.modelId)),
      profile, limits, storedEfforts: model.reasoningEfforts, storedDefault: model.defaultReasoningEffort });
    console.log(
      `[${inspected}/${models.length}] ${model.modelId}: ${profile.complete ? profile.kind : "inconclusive-preserved"}`
      + (profile.reasoningEfforts.length > 0 ? ` (${profile.reasoningEfforts.join(",")})` : ""),
    );
  }
}

if (apply) saveConfigPreservingClaudeCode(config);
if (reportPath) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ at: new Date().toISOString(), apply, models: evidence }, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, reportPath);
}
console.log(JSON.stringify({ apply, inspected, toggles, budgets, namedEfforts, fixedOrUnknown, inconclusivePreserved,
  outputLimitsKnown, limitFetchFailures }));
// No presentar una reconciliación parcial como sincronización completa.
if (limitsOnly && limitFetchFailures > 0) process.exitCode = 1;
