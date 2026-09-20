import { randomUUID } from "node:crypto";
import { fetchFeatherlessPage, isFeatherlessCatalogProvider, type FeatherlessModel } from "../../providers/featherless-catalog";
import { saveConfigPreservingClaudeCode } from "../../config";
import { clearModelCache } from "../../codex/model-cache";
import { routedSlug, slugEquals, encodedModelIdCollides } from "../../providers/slug-codec";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";

/** El middleware de gestión autentica y protege CSRF antes de despachar estas rutas. */
export async function handleFeatherlessRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (!url.pathname.startsWith("/api/featherless/")) return null;
  const providers = Object.entries(config.providers).filter(([, p]) => isFeatherlessCatalogProvider(p)).map(([name]) => name);
  if (url.pathname === "/api/featherless/models" && req.method === "GET") {
    try {
      const page = await fetchFeatherlessPage(url.searchParams);
      // El catálogo de inferencia contiene la selección explícita, no toda la búsqueda.
      const enabled = Object.fromEntries(providers.map(provider => [provider, (config.customModels ?? [])
        .filter(m => m.provider === provider && !(config.disabledModels ?? []).some(s => slugEquals(s, provider, m.modelId)))
        .map(m => m.modelId)]));
      return jsonResponse({ ...page, providers, enabled }, 200, req, config);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : "No se pudo consultar Featherless." }, 502, req, config);
    }
  }
  if (url.pathname !== "/api/featherless/selection" || req.method !== "POST") return null;
  let body: unknown;
  try { body = await readManagementJsonBody(req); } catch (error) {
    rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "JSON inválido." }, 400, req, config);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse({ error: "Selección inválida." }, 400, req, config);
  const { id, provider, enabled } = body as Record<string, unknown>;
  if (typeof id !== "string" || !id || id.length > 1024 || typeof provider !== "string" || !providers.includes(provider) || typeof enabled !== "boolean") {
    return jsonResponse({ error: "Modelo o proveedor inválido." }, 400, req, config);
  }
  try {
    let model: FeatherlessModel | undefined;
    if (enabled) {
      const page = await fetchFeatherlessPage(new URLSearchParams({ query: id }));
      model = page.items.find(m => m.id === id);
      if (!model) return jsonResponse({ error: "El modelo no tiene evidencia verificable que cumpla la política de 16B/excepciones." }, 422, req, config);
    }
    // Revalida después del await: no reintroduce un proveedor borrado concurrentemente.
    const current = config.providers[provider];
    if (!current || !isFeatherlessCatalogProvider(current)) return jsonResponse({ error: "El proveedor cambió; actualiza la página." }, 409, req, config);
    const before = { customModels: config.customModels, disabledModels: config.disabledModels, selectedModels: current.selectedModels, liveModels: current.liveModels };
    const entries = [...(config.customModels ?? [])];
    const existing = entries.find(m => m.provider === provider && m.modelId === id);
    if (encodedModelIdCollides(id, [...(current.models ?? []), ...entries.filter(m => m.provider === provider).map(m => m.modelId)])) {
      return jsonResponse({ error: "El identificador colisiona con otro selector existente." }, 409, req, config);
    }
    // Deshabilitar sigue disponible sin red y después de que un modelo desaparezca del catálogo.
    if (!enabled && !existing && !current.models?.includes(id)) return jsonResponse({ error: "El modelo no estaba configurado." }, 404, req, config);
    if (enabled && model && !existing) entries.push({ id: randomUUID(), provider, modelId: id,
      ...(model.contextLength ? { contextWindow: model.contextLength } : {}),
      inputModalities: model.inputModalities.filter(v => ["text", "image", "audio"].includes(v)),
      addedAt: new Date().toISOString() });
    config.customModels = entries;
    // Reutiliza la configuración estática upstream: catálogo remoto completo separado del selector activo.
    current.liveModels = false;
    const slug = routedSlug(provider, id);
    config.disabledModels = [...new Set((config.disabledModels ?? []).filter(s => !slugEquals(s, provider, id)))];
    if (!enabled) config.disabledModels.push(slug);
    if (enabled && current.selectedModels?.length) current.selectedModels = [...new Set([...current.selectedModels, id])];
    try { (ctx.deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode)(config); }
    catch (error) { Object.assign(config, { customModels: before.customModels, disabledModels: before.disabledModels }); current.selectedModels = before.selectedModels; current.liveModels = before.liveModels; throw error; }
    clearModelCache(provider);
    const catalogRefresh = await ctx.convergeCodexCatalog();
    return jsonResponse({ ok: true, id, provider, enabled, catalogRefresh }, 200, req, config);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "No se pudo guardar la selección." }, 502, req, config);
  }
}
