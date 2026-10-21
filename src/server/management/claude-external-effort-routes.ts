import { loadConfig, mutatePersistedConfig } from "../../config";
import { previewRouteModel } from "../../router";
import { externalEffortKey, isNativeClaudeEffortRoute } from "../../claude/external-effort";
import { supportedLadderFor } from "../effort-policy";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { loadExportModels } from "./model-rows";
import type { ManagementContext } from "./context";
class InvalidChoice extends Error {}

/** Catálogo seleccionado, no el inventario masivo del proveedor. No devuelve credenciales. */
async function rows() {
  const config = loadConfig();
  const models = await loadExportModels(config);
  return models.filter(model => {
    const provider = config.providers[model.provider];
    return provider && !isNativeClaudeEffortRoute({ providerName: model.provider, provider });
  }).map(model => {
    const key = externalEffortKey(model.provider, model.id);
    const selected = config.claudeExternalEfforts?.[key] ?? null;
    const efforts = model.reasoningEfforts ?? [];
    return { key, provider: model.provider, modelId: model.id, label: model.displayName ?? model.namespaced,
      efforts, selected, stale: selected !== null && !efforts.includes(selected) };
  });
}

/** Mutación de una sola hoja, atómica y rebasada sobre la configuración más reciente. */
export async function handleClaudeExternalEffortRoutes(ctx: ManagementContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/api/claude/external-efforts") return null;
  if (ctx.req.method === "GET") return jsonResponse({ models: await rows() });
  if (ctx.req.method !== "PUT") return null;
  let raw: unknown;
  try { raw = await readManagementJsonBody(ctx.req); }
  catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "JSON inválido" }, 400); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return jsonResponse({ error: "Se requiere un objeto" }, 400);
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some(key => !["provider", "modelId", "effort"].includes(key))
    || typeof body.provider !== "string" || typeof body.modelId !== "string"
    || (body.effort !== null && typeof body.effort !== "string")) return jsonResponse({ error: "Selección inválida" }, 400);
  const { provider, modelId, effort } = body as { provider: string; modelId: string; effort: string | null };
  const key = externalEffortKey(provider, modelId);
  if (!provider.trim() || !modelId.trim() || key.length > 1024) return jsonResponse({ error: "Identidad de modelo inválida" }, 400);
  try {
  const outcome = mutatePersistedConfig(config => {
    // Se valida dentro del bloqueo, no contra un catálogo que pudo cambiar al guardar.
    const route = previewRouteModel(config, `${provider}/${modelId}`);
    if (route.providerName !== provider || route.modelId !== modelId || isNativeClaudeEffortRoute(route)) throw new InvalidChoice("El modelo no es una ruta externa concreta");
    if (effort !== null && !supportedLadderFor(route)?.includes(effort)) throw new InvalidChoice("El esfuerzo no está declarado para este modelo");
    const previous = config.claudeExternalEfforts ?? {};
    const next = { ...previous };
    if (effort === null) delete next[key]; else next[key] = effort;
    config.claudeExternalEfforts = next;
    return { changed: previous[key] !== next[key], value: next };
  });
  if (outcome.status === "unavailable") return jsonResponse({ error: "La configuración cambió o no está disponible; no se guardó la selección" }, 409);
  ctx.config.claudeExternalEfforts = outcome.value;
  return jsonResponse({ key, selected: effort, saved: true });
  } catch (error) {
    return jsonResponse({ error: error instanceof InvalidChoice ? error.message : "No se pudo validar y guardar la selección; la configuración no fue sustituida" }, error instanceof InvalidChoice ? 400 : 409);
  }
}
