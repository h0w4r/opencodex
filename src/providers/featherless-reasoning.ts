import { createHash } from "node:crypto";
import type { OcxCustomModel, OcxProviderConfig } from "../types";

/** Contrato probado del selector de razonamiento que Codex puede representar. */
export interface FeatherlessReasoningProfile {
  kind: "toggle" | "budget" | "fixed-or-unknown";
  reasoningEfforts: string[];
  defaultReasoningEffort?: string;
  defaultEnabled: boolean | null;
  checkedAt: string;
  evidence: {
    source: "featherless-debug-chat-format";
    omittedHash?: string;
    disabledHash?: string;
    enabledHash?: string;
    budgetLowHash?: string;
    budgetHighHash?: string;
    statuses: number[];
  };
}

interface RenderedTemplate {
  status: number;
  prompt?: string;
}

export interface FeatherlessReasoningProbeDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  retryDelayMs?: number;
}

const hash = (value: string | undefined): string | undefined => value === undefined
  ? undefined
  : createHash("sha256").update(value).digest("hex");

async function renderTemplateOnce(
  modelId: string,
  apiKey: string,
  kwargs: Record<string, unknown> | undefined,
  deps: FeatherlessReasoningProbeDeps,
): Promise<RenderedTemplate> {
  const fetchImpl = deps.fetch ?? fetch;
  const encoded = modelId.split("/").map(encodeURIComponent).join("/");
  const controller = new AbortController();
  // El endpoint solo formatea una plantilla: este límite protege el handshake atómico,
  // no cancela una inferencia viva ni un proceso que siga mostrando progreso.
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 30_000);
  try {
    const response = await fetchImpl(`https://api.featherless.ai/models/${encoded}/debug/chat-format`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Responde pong." }],
        ...(kwargs ? { chat_template_kwargs: kwargs } : {}),
      }),
    });
    if (!response.ok) return { status: response.status };
    const body = await response.json() as Record<string, unknown>;
    return {
      status: response.status,
      ...(typeof body.formatted_prompt === "string" ? { prompt: body.formatted_prompt } : {}),
    };
  } catch {
    return { status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function renderTemplate(
  modelId: string,
  apiKey: string,
  kwargs: Record<string, unknown> | undefined,
  deps: FeatherlessReasoningProbeDeps,
): Promise<RenderedTemplate> {
  let last: RenderedTemplate = { status: 0 };
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await renderTemplateOnce(modelId, apiKey, kwargs, deps);
    // Los errores de contrato/autorización no sanan repitiendo; red, 429 y 5xx sí son transitorios.
    if (last.prompt !== undefined || (last.status > 0 && last.status !== 429 && last.status < 500)) return last;
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, deps.retryDelayMs ?? 500 * (attempt + 1)));
  }
  return last;
}

/**
 * Prueba el contrato real de la plantilla. Un HTTP 200 no basta: Featherless acepta kwargs
 * desconocidos y puede ignorarlos, de modo que sólo una diferencia de prompt acredita soporte.
 */
export async function probeFeatherlessReasoningProfile(
  modelId: string,
  apiKey: string | undefined,
  deps: FeatherlessReasoningProbeDeps = {},
): Promise<FeatherlessReasoningProfile> {
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString();
  if (!apiKey?.trim()) {
    return {
      kind: "fixed-or-unknown",
      reasoningEfforts: [],
      defaultEnabled: null,
      checkedAt,
      evidence: { source: "featherless-debug-chat-format", statuses: [0] },
    };
  }

  const [omitted, disabled, enabled] = await Promise.all([
    renderTemplate(modelId, apiKey, undefined, deps),
    renderTemplate(modelId, apiKey, { enable_thinking: false }, deps),
    renderTemplate(modelId, apiKey, { enable_thinking: true }, deps),
  ]);
  const baseEvidence = {
    source: "featherless-debug-chat-format" as const,
    omittedHash: hash(omitted.prompt),
    disabledHash: hash(disabled.prompt),
    enabledHash: hash(enabled.prompt),
    statuses: [omitted.status, disabled.status, enabled.status],
  };
  const toggleWorks = disabled.prompt !== undefined
    && enabled.prompt !== undefined
    && disabled.prompt !== enabled.prompt;
  if (!toggleWorks) {
    return {
      kind: "fixed-or-unknown",
      reasoningEfforts: [],
      defaultEnabled: omitted.prompt !== undefined && enabled.prompt !== undefined
        && omitted.prompt === enabled.prompt ? true
        : omitted.prompt !== undefined && disabled.prompt !== undefined
          && omitted.prompt === disabled.prompt ? false : null,
      checkedAt,
      evidence: baseEvidence,
    };
  }

  // Un presupuesto se anuncia únicamente si dos valores cambian de verdad la plantilla.
  // Esto evita confundir "kwarg aceptado" con "capacidad soportada".
  const [budgetLow, budgetHigh] = await Promise.all([
    renderTemplate(modelId, apiKey, { enable_thinking: true, thinking_budget: 64 }, deps),
    renderTemplate(modelId, apiKey, { enable_thinking: true, thinking_budget: 512 }, deps),
  ]);
  const budgetWorks = budgetLow.prompt !== undefined
    && budgetHigh.prompt !== undefined
    && budgetLow.prompt !== budgetHigh.prompt;
  const defaultEnabled = omitted.prompt === enabled.prompt
    ? true
    : omitted.prompt === disabled.prompt ? false : null;
  return {
    kind: budgetWorks ? "budget" : "toggle",
    reasoningEfforts: budgetWorks
      ? ["none", "low", "medium", "high", "xhigh", "max"]
      : ["none", "high"],
    defaultReasoningEffort: defaultEnabled === false ? "none" : "high",
    defaultEnabled,
    checkedAt,
    evidence: {
      ...baseEvidence,
      budgetLowHash: hash(budgetLow.prompt),
      budgetHighHash: hash(budgetHigh.prompt),
      statuses: [...baseEvidence.statuses, budgetLow.status, budgetHigh.status],
    },
  };
}

function setMembership(values: string[] | undefined, modelId: string, present: boolean): string[] | undefined {
  const next = [...new Set((values ?? []).filter(value => value !== modelId))];
  if (present) next.push(modelId);
  return next.length > 0 ? next : undefined;
}

function setRecord<T>(
  record: Record<string, T> | undefined,
  modelId: string,
  value: T | undefined,
): Record<string, T> | undefined {
  const next = { ...(record ?? {}) };
  if (value === undefined) delete next[modelId];
  else next[modelId] = value;
  return Object.keys(next).length > 0 ? next : undefined;
}

function isDeepSeekThinkingModel(modelId: string): boolean {
  return /(?:^|\/)(?:deepseek[^/]*[-_])?(?:deepseek[-_])?(?:v3\.[12]|v4(?:\.|-|$)|r1(?:-|$))/i.test(modelId);
}

/**
 * Proyecta el perfil probado sobre el catálogo y el transporte. El custom model controla lo que
 * ve Codex; los mapas del proveedor controlan exactamente qué llega a Featherless.
 */
export function applyFeatherlessReasoningProfile(
  provider: OcxProviderConfig,
  customModel: OcxCustomModel,
  profile: FeatherlessReasoningProfile,
): void {
  const modelId = customModel.modelId;
  customModel.reasoningEfforts = [...profile.reasoningEfforts];
  if (profile.defaultReasoningEffort) customModel.defaultReasoningEffort = profile.defaultReasoningEffort;
  else delete customModel.defaultReasoningEffort;

  provider.modelReasoningEfforts = setRecord(provider.modelReasoningEfforts, modelId, [...profile.reasoningEfforts]);
  provider.modelDefaultReasoningEfforts = setRecord(
    provider.modelDefaultReasoningEfforts,
    modelId,
    profile.defaultReasoningEffort,
  );
  provider.modelSuppressSyntheticMax = setRecord(provider.modelSuppressSyntheticMax, modelId, true);

  const supportsToggle = profile.kind === "toggle" || profile.kind === "budget";
  const wireMap: Record<string, string> | undefined = profile.kind === "toggle"
    ? { none: "disabled", high: "enabled" }
    : profile.kind === "budget" ? { none: "disabled" } : undefined;
  provider.modelReasoningEffortMap = setRecord(provider.modelReasoningEffortMap, modelId, wireMap);
  provider.thinkingBudgetModels = setMembership(provider.thinkingBudgetModels, modelId, profile.kind === "budget");
  provider.preserveReasoningContentModels = setMembership(
    provider.preserveReasoningContentModels,
    modelId,
    supportsToggle,
  );
  // DeepSeek rechaza continuaciones de tool calls sin reasoning_content cuando thinking está
  // activo. El serializador evita este placeholder cuando el operador seleccionó `none`.
  provider.requiresReasoningPlaceholderModels = setMembership(
    provider.requiresReasoningPlaceholderModels,
    modelId,
    supportsToggle && isDeepSeekThinkingModel(modelId),
  );
}
