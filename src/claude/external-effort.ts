import type { OcxConfig, OcxParsedRequest } from "../types";
import type { RouteResult } from "../router";
import { anthropicInstanceRowShapeMatches } from "../providers/anthropic-instance-id";
import { supportedLadderFor } from "../server/effort-policy";
const choicesByRequest = new WeakMap<OcxParsedRequest, Record<string, string>>();

/** Identidad exacta: no depende del alias visible ni de prefijos del nombre comercial. */
export function externalEffortKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

/** Las cuentas Anthropic nativas no participan en esta política. */
export function isNativeClaudeEffortRoute(route: Pick<RouteResult, "providerName" | "provider">): boolean {
  return anthropicInstanceRowShapeMatches(route.providerName, route.provider);
}

/** Una elección obsoleta falla explícitamente; nunca se convierte en otro nivel en silencio. */
export function claudeExternalEffortDecision(
  config: OcxConfig,
  route: Pick<RouteResult, "providerName" | "provider" | "modelId">,
  inboundWire: string,
  parsed?: OcxParsedRequest,
): { effort?: string; error?: string; code?: string } {
  if (inboundWire !== "anthropic" || isNativeClaudeEffortRoute(route)) return {};
  const key = externalEffortKey(route.providerName, route.modelId);
  // Una edición de la GUI no cambia una petición ya admitida ni sus reintentos.
  let choices = config.claudeExternalEfforts ?? {};
  if (parsed) {
    if (!choicesByRequest.has(parsed)) choicesByRequest.set(parsed, { ...choices });
    choices = choicesByRequest.get(parsed)!;
  }
  const effort = choices[key];
  const ladder = supportedLadderFor(route);
  if (effort === undefined) {
    // El modo cliente tampoco convierte un nivel inválido en otro de forma silenciosa.
    const requested = parsed?.options.reasoning;
    if (requested && ladder?.length && !ladder.includes(requested)) return {
      code: "external_effort_invalid", error: "El esfuerzo solicitado por Claude no está declarado para este modelo. Selecciona uno válido en el panel de esfuerzo externo de OpenCodex.",
    };
    return {};
  }
  if (!ladder?.includes(effort)) return { code: "external_effort_stale", error: "La selección de esfuerzo de OpenCodex ya no figura en la escala verificada del modelo. Actualízala o elimínala en Integraciones → Claude." };
  return { effort };
}

/** Reescribe ambos contratos del runtime; none es un apagado explícito, no ausencia de campo. */
export function applyClaudeExternalEffort(
  parsed: OcxParsedRequest,
  config: OcxConfig,
  route: Pick<RouteResult, "providerName" | "provider" | "modelId">,
  inboundWire: string,
): string | undefined {
  const decision = claudeExternalEffortDecision(config, route, inboundWire, parsed);
  if (decision.error) throw new Error(decision.error);
  if (decision.effort === undefined) return undefined;
  parsed.options.reasoning = decision.effort;
  const raw = parsed._rawBody as { reasoning?: Record<string, unknown> } | undefined;
  if (raw && typeof raw === "object") raw.reasoning = { ...raw.reasoning, effort: decision.effort };
  return decision.effort;
}
