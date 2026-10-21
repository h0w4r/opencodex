import { createHash } from "node:crypto";
import { type OcxConfig, type OcxCustomModel, type OcxProviderConfig } from "../types";
import { isFeatherlessCatalogProvider } from "./featherless-catalog";
import { slugEquals } from "./slug-codec";
import { fetchReasoningDeclaration, type ReasoningDeclaration } from "./featherless-reasoning-declaration";

/** Contrato probado del selector de razonamiento que Codex puede representar. */
export interface FeatherlessReasoningProfile {
  kind: "toggle" | "budget" | "effort" | "fixed-or-unknown";
  /** Todos los controles necesarios respondieron; sólo entonces puede reemplazar evidencia previa. */
  complete: boolean;
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
    effortHashes?: Record<string, string>;
    /** Sólo metadatos del delimitador; nunca se persiste el prompt formateado. */
    thinkingPrefill?: boolean;
    declaration?: ReasoningDeclaration;
    stableToggle?: boolean;
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
        // El endpoint documenta también el campo OpenAI nativo; nunca divergen.
        ...(typeof kwargs?.reasoning_effort === "string" ? { reasoning_effort: kwargs.reasoning_effort } : {}),
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
      complete: false,
      reasoningEfforts: [],
      defaultEnabled: null,
      checkedAt,
      evidence: { source: "featherless-debug-chat-format", statuses: [0] },
    };
  }

  const omitted = await renderTemplate(modelId, apiKey, undefined, deps);
  const disabled = await renderTemplate(modelId, apiKey, { enable_thinking: false }, deps);
  const enabled = await renderTemplate(modelId, apiKey, { enable_thinking: true }, deps);
  // Una respuesta aislada de un formatter inconsistente no acredita un interruptor.
  const disabledAgain = await renderTemplate(modelId, apiKey, { enable_thinking: false }, deps);
  const enabledAgain = await renderTemplate(modelId, apiKey, { enable_thinking: true }, deps);
  const stableToggle = disabled.prompt !== undefined && enabled.prompt !== undefined
    && disabled.prompt === disabledAgain.prompt && enabled.prompt === enabledAgain.prompt;
  const baseEvidence = {
    source: "featherless-debug-chat-format" as const,
    omittedHash: hash(omitted.prompt),
    disabledHash: hash(disabled.prompt),
    enabledHash: hash(enabled.prompt),
    thinkingPrefill: /<(?:think|thinking|reasoning)>\s*$/.test(enabled.prompt ?? ""),
    stableToggle,
    statuses: [omitted.status, disabled.status, enabled.status],
  };
  const toggleWorks = stableToggle && disabled.prompt !== undefined
    && enabled.prompt !== undefined
    && disabled.prompt !== enabled.prompt;
  // La igualdad de tres plantillas no demuestra si el modelo razona por defecto.
  const defaultEnabled = toggleWorks
    ? omitted.prompt === enabled.prompt ? true : omitted.prompt === disabled.prompt ? false : null
    : /<(?:think|thinking|reasoning)>\s*$/.test(omitted.prompt ?? "") ? true : null;
  // Algunos modelos siempre razonan y ofrecen niveles nominales en la plantilla,
  // aunque no acepten enable_thinking. Una igualdad o un 200 aislado no los acredita.
  // Primero los valores consolidados: una etiqueta desconocida que cae al default
  // no debe desplazar a un nivel ya comprobado con el mismo resultado.
  const namedEfforts = ["low", "medium", "high", "xhigh", "max", "minimal", "ultra"];
  const named = await Promise.all(namedEfforts.map(effort =>
    renderTemplate(modelId, apiKey, { reasoning_effort: effort }, deps)));
  const hashes: Record<string, string> = {};
  const distinct = new Set<string>();
  for (const [i, rendered] of named.entries()) {
    if (rendered.prompt === undefined) continue;
    const digest = hash(rendered.prompt)!;
    if (distinct.has(digest)) continue;
    distinct.add(digest);
    hashes[namedEfforts[i]!] = digest;
  }
  const namedConclusive = named.every(result => [200, 400, 422].includes(result.status));
  const declaration = await fetchReasoningDeclaration(modelId, deps.fetch ?? fetch);
  let namedStable = true;
  if (!declaration && distinct.size > 1) {
    // Un formatter que alterna plantillas no puede inventar ni retirar niveles.
    for (const [index, effort] of namedEfforts.entries()) {
      const repeated = await renderTemplate(modelId, apiKey, { reasoning_effort: effort }, deps);
      namedStable &&= repeated.status === named[index]!.status && repeated.prompt === named[index]!.prompt;
    }
  }
  if ((declaration || distinct.size > 1) && namedConclusive) {
    const order = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
    const efforts = [...new Set([...(toggleWorks ? ["none"] : []), ...(declaration?.efforts ?? Object.keys(hashes))])]
      .sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const defaultEffort = declaration?.defaultEffort ?? (toggleWorks && omitted.prompt === disabled.prompt ? "none"
      : efforts.find(effort => hashes[effort] === baseEvidence.omittedHash));
    return {
      kind: "effort", complete: omitted.prompt !== undefined && namedStable,
      reasoningEfforts: efforts, ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
      defaultEnabled: defaultEffort ? defaultEffort !== "none" : defaultEnabled, checkedAt,
      evidence: { ...baseEvidence, ...(declaration ? { declaration } : {}), effortHashes: hashes, statuses: [...baseEvidence.statuses, ...named.map(result => result.status)] },
    };
  }
  if (!toggleWorks) {
    return {
      kind: "fixed-or-unknown",
      complete: namedConclusive && stableToggle && [omitted, disabled, enabled].every(rendered => rendered.prompt !== undefined),
      reasoningEfforts: [],
      defaultEnabled,
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
  return {
    kind: budgetWorks ? "budget" : "toggle",
    // La escala binaria está probada, pero no se afirma que sea exhaustiva si
    // alguno de los dos presupuestos no pudo contrastarse con el formatter.
    complete: namedConclusive && budgetLow.prompt !== undefined && budgetHigh.prompt !== undefined,
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
  // Una interrupción temporal del endpoint de debug no puede borrar una escala
  // que ya fue acreditada. El llamador puede conservar el perfil y reintentarlo.
  if (!profile.complete) return;
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

  const supportsToggle = profile.reasoningEfforts.includes("none");
  const wireMap: Record<string, string> | undefined = profile.kind === "toggle"
    ? { none: "disabled", high: "enabled" }
    : profile.kind === "budget" ? { none: "disabled" }
      : profile.kind === "effort" ? Object.fromEntries(profile.reasoningEfforts.map(effort => [effort,
        effort === "none" && !profile.evidence.declaration?.efforts.includes("none") ? "disabled" : `template:${effort}`])) : undefined;
  provider.modelReasoningEffortMap = setRecord(provider.modelReasoningEffortMap, modelId, wireMap);
  provider.thinkingBudgetModels = setMembership(provider.thinkingBudgetModels, modelId, profile.kind === "budget");
  // No inferirlo del nombre del modelo: la plantilla real debe terminar con una apertura.
  if (profile.evidence.thinkingPrefill !== undefined) {
    provider.inlineThinkTagModels = setMembership(provider.inlineThinkTagModels, modelId, profile.evidence.thinkingPrefill);
  }
  provider.preserveReasoningContentModels = setMembership(
    provider.preserveReasoningContentModels,
    modelId,
    // La ausencia de controles seleccionables no significa ausencia de razonamiento.
    // Conservar contenido realmente devuelto también cubre modelos always-on.
    true,
  );
  // DeepSeek rechaza continuaciones de tool calls sin reasoning_content cuando thinking está
  // activo. El serializador evita este placeholder cuando el operador seleccionó `none`.
  provider.requiresReasoningPlaceholderModels = setMembership(
    provider.requiresReasoningPlaceholderModels,
    modelId,
    supportsToggle && isDeepSeekThinkingModel(modelId),
  );
}

// Caché sólo de controles comprobados, nunca de credenciales ni contenido de prompts.
const profileCache = new Map<string, { expires: number; profile: FeatherlessReasoningProfile }>();

/** Revalida selecciones activas sin inferencias ni explorar todo el catálogo remoto. */
export async function refreshFeatherlessReasoningProfiles(config: OcxConfig): Promise<boolean> {
  let changed = false;
  for (const [providerName, provider] of Object.entries(config.providers)) {
    if (!isFeatherlessCatalogProvider(provider)) continue;
    const models = (config.customModels ?? []).filter(model => model.provider === providerName
      && !(config.disabledModels ?? []).some(slug => slugEquals(slug, providerName, model.modelId)));
    if (!models.length) continue;
    const { resolveModelsAuthToken } = await import("../oauth");
    const token = await resolveModelsAuthToken(providerName, provider);
    if (!token) continue;
    for (const model of models) {
      const key = `${provider.baseUrl}:${providerName}:${model.modelId}`;
      const cached = profileCache.get(key);
      const profile = cached && cached.expires > Date.now() ? cached.profile
        : await probeFeatherlessReasoningProfile(model.modelId, token);
      // No extender la vigencia al leer: de otro modo nunca se revalidaría.
      if (profile !== cached?.profile) profileCache.set(key, {
        profile, expires: Date.now() + (profile.complete ? 6 * 60 * 60_000 : 15 * 60_000),
      });
      const before = JSON.stringify([provider, model]);
      applyFeatherlessReasoningProfile(provider, model, profile);
      changed ||= before !== JSON.stringify([provider, model]);
    }
  }
  return changed;
}
