/** Proyecta metadatos del modelo seleccionado sin mutar configuración ni modelos vecinos. */
import { modelRecordValue } from "../reasoning-effort";
import type { OcxConfig, OcxProviderConfig } from "../types";

export function withConfiguredModelTokenLimits(
  config: Pick<OcxConfig, "customModels"> | undefined,
  providerName: string,
  modelId: string,
  provider: OcxProviderConfig,
): OcxProviderConfig {
  const row = config?.customModels?.find(model => model.provider === providerName && model.modelId === modelId);
  const window = row?.contextWindow;
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return provider;
  const configured = modelRecordValue(provider.modelContextWindows, modelId) ?? provider.contextWindow;
  const effective = typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.min(window, configured) : window;
  // El límite explícito del proveedor sólo puede estrechar los metadatos conocidos.
  return { ...provider, modelContextWindows: { ...provider.modelContextWindows, [modelId]: effective } };
}
