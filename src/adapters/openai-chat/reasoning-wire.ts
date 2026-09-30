import { modelInList, type OcxProviderConfig } from "../../types";
import type { AdapterRequest } from "../base";
import { isNativeOpenAIChatTarget } from "./wire";
import { isFeatherlessCatalogProvider } from "../../providers/featherless-catalog";

export type ExplicitChatReasoningWireResult =
  | { handled: false }
  | { handled: true; reasoningLog?: AdapterRequest["reasoningLog"] };

/**
 * Apply provider-declared reasoning wire policy after the effective provider is resolved.
 * Unset declarations are a no-op so native Chat keeps forwarding the caller's raw field.
 */
export function applyExplicitChatReasoningWirePolicy(options: {
  provider: OcxProviderConfig;
  modelId: string;
  hasTools: boolean;
  requestedEffort: string | undefined;
  wireEffort: string | undefined;
  reasoningDisabled: boolean;
  body: Record<string, unknown>;
  maxOutputTokens?: number;
}): ExplicitChatReasoningWireResult {
  const {
    provider,
    modelId,
    hasTools,
    requestedEffort,
    wireEffort,
    reasoningDisabled,
    body,
  } = options;

  if (reasoningDisabled) return { handled: false };
  // Un único compilador para Responses, Messages y Chat: nunca enviar aliases
  // internos enabled/disabled como reasoning_effort estándar a Featherless.
  if (isFeatherlessCatalogProvider(provider) && wireEffort !== undefined
      && (wireEffort === "enabled" || wireEffort === "disabled"
        || wireEffort.startsWith("template:")
        || modelInList(provider.thinkingBudgetModels, modelId))) {
    const enabled = wireEffort !== "disabled";
    const kwargs: Record<string, unknown> = wireEffort.startsWith("template:")
      ? { reasoning_effort: wireEffort.slice("template:".length) }
      : { enable_thinking: enabled };
    if (enabled) {
      kwargs.preserve_thinking = true;
      kwargs.clear_thinking = false;
      if (modelInList(provider.thinkingBudgetModels, modelId)) {
        const budget = chatThinkingBudgetForEffort(requestedEffort, wireEffort, options.maxOutputTokens);
        if (budget !== undefined) kwargs.thinking_budget = budget;
      }
    }
    delete body.reasoning_effort;
    delete body.reasoning;
    body.chat_template_kwargs = kwargs;
    return { handled: true, reasoningLog: wireEffort.startsWith("template:")
      ? { effectiveEffort: requestedEffort ?? wireEffort, wireField: "chat_template_kwargs.reasoning_effort", wireValue: wireEffort.slice(9) }
      : { effectiveEffort: requestedEffort ?? wireEffort, wireField: "chat_template_kwargs.enable_thinking", wireValue: enabled } };
  }
  if (hasTools && modelInList(provider.omitReasoningEffortWithToolsModels, modelId)) {
    delete body.reasoning_effort;
    delete body.reasoning;
    return { handled: true };
  }
  if (provider.reasoningWireFormat !== "gateway-object") return { handled: false };

  const nativeOpenAI = isNativeOpenAIChatTarget(provider);
  if (requestedEffort === "none") {
    if (nativeOpenAI) {
      delete body.reasoning;
      body.reasoning_effort = "none";
      return {
        handled: true,
        reasoningLog: {
          effectiveEffort: "none",
          wireField: "reasoning_effort",
          wireValue: "none",
        },
      };
    }
    delete body.reasoning_effort;
    body.reasoning = { enabled: false };
    return {
      handled: true,
      reasoningLog: {
        effectiveEffort: "none",
        wireField: "reasoning.enabled",
        wireValue: false,
      },
    };
  }
  if (wireEffort === undefined) return { handled: false };

  if (nativeOpenAI) {
    delete body.reasoning;
    body.reasoning_effort = wireEffort;
    return {
      handled: true,
      reasoningLog: {
        effectiveEffort: wireEffort,
        wireField: "reasoning_effort",
        wireValue: wireEffort,
      },
    };
  }
  delete body.reasoning_effort;
  body.reasoning = { enabled: true, effort: wireEffort };
  return {
    handled: true,
    reasoningLog: {
      effectiveEffort: wireEffort,
      wireField: "reasoning.effort",
      wireValue: wireEffort,
    },
  };
}

/** Presupuesto común a todos los protocolos; es una proyección local, no niveles del proveedor. */
export function chatThinkingBudgetForEffort(requested: string | undefined, effort: string, maxOutputTokens?: number): number | undefined {
  if (requested === "minimal") return 0;
  const fractions: Record<string, number> = { low: 0.20, medium: 0.50, high: 0.75, xhigh: 0.90, max: 1.0 };
  const fraction = fractions[effort];
  return fraction === undefined ? undefined : Math.max(1, Math.floor((maxOutputTokens ?? 32768) * fraction));
}
