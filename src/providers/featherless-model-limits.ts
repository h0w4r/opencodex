import { featherlessDetailUrl, fetchFeatherlessWithRetry } from "./featherless-catalog";
import type { OcxCustomModel, OcxProviderConfig } from "../types";

export interface FeatherlessModelLimits {
  status: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  checkedAt: string;
  source: string;
}

/** Consulta metadata del destino real; no usa límites del modelo base en otra plataforma. */
export async function fetchFeatherlessModelLimits(
  modelId: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<FeatherlessModelLimits> {
  const source = featherlessDetailUrl(modelId);
  const checkedAt = new Date().toISOString();
  const result: FeatherlessModelLimits = { status: 0, source, checkedAt };
  if (!token) return result;
  try {
    const response = await fetchFeatherlessWithRetry(source, {
      redirect: "error", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    }, { fetch: fetchImpl });
    result.status = response.status;
    if (!response.ok) return result;
    const raw = await response.json() as Record<string, unknown>;
    const row = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
      ? raw.data as Record<string, unknown> : raw;
    // Un cuerpo de otro modelo jamás puede modificar la política del solicitado.
    if (row.id !== modelId) return result;
    const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
    if (positive(row.context_length)) result.contextWindow = row.context_length;
    if (positive(row.max_completion_tokens)) result.maxOutputTokens = row.max_completion_tokens;
  } catch { /* Una consulta fallida conserva los límites previamente conocidos. */ }
  return result;
}

/** Alimenta el mismo mapa que usa el compilador físico de Requests/Messages/Chat. */
export function applyFeatherlessModelLimits(
  provider: OcxProviderConfig,
  model: OcxCustomModel,
  limits: FeatherlessModelLimits,
): void {
  if (limits.contextWindow !== undefined) {
    model.contextWindow = limits.contextWindow;
    (provider.modelContextWindows ??= {})[model.modelId] = limits.contextWindow;
  }
  if (limits.maxOutputTokens !== undefined) {
    (provider.modelMaxOutputTokens ??= {})[model.modelId] = limits.maxOutputTokens;
  }
}
