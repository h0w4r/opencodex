/** Catálogo público paginado: no contiene credenciales ni modifica el transporte de inferencia. */
export const FEATHERLESS_MIN_PARAMETERS = 16_000_000_000;
export const FEATHERLESS_FACETS = ["modalities", "parameter_bucket", "family", "capabilities", "architectures", "languages", "domains", "creative", "training", "license", "popularity_level"] as const;
export const FEATHERLESS_SORTS = ["-trending_rank", "-downloads", "-favorites", "-hf_created_at", "-parameter_size", "-avg_rating"] as const;

/** No intercepta un destino personalizado aunque su proveedor se llame featherless. */
export function isFeatherlessCatalogProvider(provider: { baseUrl: string; adapter: string }): boolean {
  return provider.adapter === "openai-chat" && provider.baseUrl.replace(/\/+$/, "") === "https://api.featherless.ai/v1";
}

export interface FeatherlessModel {
  id: string;
  parameterSize: number | null;
  contextLength: number | null;
  toolUse: boolean | null;
  status: string;
  tags: Record<string, string[]>;
  inputModalities: string[];
  downloads: number;
  favorites: number;
  releasedAt: string | null;
  reason: "parameters" | "exception" | "excluded" | "unknown" | "tools-unsupported" | "tools-unverified";
  toolEvidence: string[];
  evidence: string[];
}
export interface FeatherlessPage {
  items: FeatherlessModel[];
  pagination: { current_page: number; per_page: number; total_items: number; total_pages: number };
  facets: Record<string, Array<{ value: string; count: number }>>;
  inspected: number;
  excluded: number;
  unknown: number;
  toolsUnsupported: number;
  toolsUnverified: number;
  fetchedAt: string;
  source: string;
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positive = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
const texts = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
// Los términos son evidencia declarada, no una garantía sobre el comportamiento o las capacidades.
export const FEATHERLESS_EXCEPTION = /(?:^|[^a-z0-9])(?:uncensored|unfiltered|abliterat(?:ed|ion|ing|e)?|obliterat(?:ed|ion|ing|e)?|de[-_ ]?censored|decensor(?:ed)?|de[-_ ]?restricted|unrestricted|de[-_ ]?aligned|refusal[-_ ]?(?:removed|removal|free)|no[-_ ]?refusals?|anti[-_ ]?refusal|jailbroken|cyber[-_ ]?security|cybersec|cyber[-_ ]?(?:defense|defence)|pentest(?:ing)?|penetration[-_ ]?testing|offensive[-_ ]?security|offsec|vulnerability[-_ ]?(?:detection|analysis)|malware[-_ ]?analysis|red[-_ ]?team(?:ing)?)(?:$|[^a-z0-9])/i;

/** Usa parámetros totales publicados; nunca adivina tamaño a partir de A3B u otro nombre MoE. */
export function classifyFeatherlessModel(value: unknown): FeatherlessModel {
  const row = record(value);
  if (typeof row.id !== "string" || !row.id || row.id.length > 1024 || /[\u0000-\u001f]/.test(row.id)) throw new Error("Identificador de modelo inválido en Featherless.");
  const modelClass = record(row.model_class);
  const parameterSize = positive(row.parameter_size) ?? positive(modelClass.parameter_size);
  const tags: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(record(row.classified_tags))) tags[key] = texts(values);
  // La API de detalle emplea tags, mientras la búsqueda facetada emplea classified_tags.
  if (Array.isArray(row.tags)) tags.tags = texts(row.tags);
  if (typeof row.family === "string") tags.family = [row.family];
  if (typeof row.license === "string") tags.license = [row.license];
  const evidence: string[] = [];
  for (const [key, values] of Object.entries(tags)) for (const tag of values) {
    // Una licencia unrestricted o una familia con nombre parecido no acredita descensura.
    if (!["training", "domains", "capabilities", "content_flags", "tags"].includes(key)) continue;
    if (FEATHERLESS_EXCEPTION.test(tag) || (key === "domains" && tag === "security")) evidence.push(`${key}:${tag}`);
  }
  // El namespace de un autor no demuestra especialización de todos sus modelos.
  const name = row.id.substring(row.id.indexOf("/") + 1);
  if (FEATHERLESS_EXCEPTION.test(name)) evidence.push(`model-name:${name}`);
  // Un no explícito prevalece ante metadatos contradictorios. Nombres, familias y
  // etiquetas genéricas de agente no prueban que el transporte soporte tools.
  const flags = [["supports_tool_calling", row.supports_tool_calling], ["features.tool_use", record(row.features).tool_use]] as const;
  const declared = flags.filter(([, value]) => typeof value === "boolean");
  const toolUse = declared.some(([, value]) => value === false) ? false : declared.some(([, value]) => value === true) ? true : null;
  const toolEvidence = declared.map(([key, value]) => `${key}:${value}`);
  const reason = toolUse === false ? "tools-unsupported" : toolUse === null ? "tools-unverified"
    : parameterSize !== null && parameterSize >= FEATHERLESS_MIN_PARAMETERS ? "parameters"
    : evidence.length ? "exception" : parameterSize === null ? "unknown" : "excluded";
  return {
    id: row.id, parameterSize, reason, evidence, tags, toolUse, toolEvidence,
    contextLength: positive(row.context_length) ?? positive(modelClass.context_length),
    status: typeof row.status === "string" ? row.status : "unknown",
    inputModalities: texts(row.input_modalities ?? modelClass.input_modalities),
    downloads: positive(row.downloads) ?? 0, favorites: positive(row.favorites) ?? 0,
    releasedAt: typeof row.hf_created_at === "string" ? row.hf_created_at : null,
  };
}

/** Lista cerrada de parámetros: no acepta URLs, headers, secretos ni destinos proporcionados por el navegador. */
export function featherlessSearchUrl(input: URLSearchParams): URL {
  const url = new URL("https://api.featherless.ai/feather/search/models");
  const page = Number(input.get("page") ?? 1);
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Página inválida.");
  url.searchParams.set("page", String(page));
  url.searchParams.set("perPage", "100");
  const sort = input.get("sort") ?? FEATHERLESS_SORTS[0];
  if (!(FEATHERLESS_SORTS as readonly string[]).includes(sort)) throw new Error("Orden inválido.");
  url.searchParams.set("sort", sort);
  url.searchParams.set("prioritize_warm", input.get("prioritize_warm") === "true" ? "true" : "false");
  const query = input.get("query")?.trim();
  if (query && query.length > 1024) throw new Error("Búsqueda demasiado larga.");
  if (query) url.searchParams.set("query", query);
  for (const key of FEATHERLESS_FACETS) {
    const values = [...new Set(input.getAll(key))].sort();
    if (values.length > 50 || values.some(v => !v || v.length > 100)) throw new Error("Filtro inválido.");
    for (const value of values) url.searchParams.append(key, value);
  }
  // Filtra en origen para no paginar por miles de chatbots. La comprobación
  // local de flags sigue siendo obligatoria aunque el proveedor combine facetas con OR.
  if (!url.searchParams.getAll("capabilities").includes("tool-use")) url.searchParams.append("capabilities", "tool-use");
  for (const key of ["featherless_exclusive", "trending"]) if (input.get(key) === "true") url.searchParams.set(key, "true");
  const recency = input.get("release_recency");
  if (recency) {
    if (!["30", "90", "180", "365"].includes(recency)) throw new Error("Intervalo de publicación inválido.");
    const now = new Date();
    url.searchParams.set("released_before", now.toISOString().slice(0, 10));
    url.searchParams.set("released_after", new Date(now.getTime() - Number(recency) * 86400000).toISOString().slice(0, 10));
  }
  return url;
}

// Caché acotada y solicitudes concurrentes deduplicadas; la página 501 no queda prohibida por ningún top-N local.
const pages = new Map<string, { expires: number; value: FeatherlessPage }>();
const flights = new Map<string, Promise<FeatherlessPage>>();
export function featherlessSourceUrl(input: URLSearchParams, bounds: { min?: number; max?: number } = {}): URL {
  const sourceUrl = featherlessSearchUrl(input);
  // La búsqueda del sitio expresa estos límites en miles de millones, no en unidades.
  sourceUrl.searchParams.set("supports_tool_calling", "true");
  // La API combina valores de una misma faceta con OR. No unir una excepción
  // con tool-use: ampliaría la consulta a todos los modelos con herramientas.
  // El booleano de arriba impone tools de forma independiente (AND).
  if (input.has("capabilities")) {
    sourceUrl.searchParams.delete("capabilities");
    for (const value of input.getAll("capabilities")) sourceUrl.searchParams.append("capabilities", value);
  }
  if (bounds.min !== undefined) sourceUrl.searchParams.set("parameter_size_min", String(bounds.min));
  if (bounds.max !== undefined) sourceUrl.searchParams.set("parameter_size_max", String(bounds.max));
  return sourceUrl;
}

/**
 * Una prueba runtime vigente corrige metadatos negativos o ausentes, pero no
 * omite el umbral de tamaño ni las excepciones declaradas por el publicador.
 */
export function applyFeatherlessToolProof(model: FeatherlessModel, label: string): FeatherlessModel {
  const reason = model.parameterSize !== null && model.parameterSize >= FEATHERLESS_MIN_PARAMETERS ? "parameters"
    : model.evidence.length ? "exception" : model.parameterSize === null ? "unknown" : "excluded";
  return { ...model, toolUse: true, reason, toolEvidence: [...model.toolEvidence, label] };
}
export async function fetchFeatherlessSourcePage(input: URLSearchParams, bounds: { min?: number; max?: number } = {}): Promise<FeatherlessPage> {
  const url = featherlessSourceUrl(input, bounds).href;
  const hit = pages.get(url);
  if (hit && hit.expires > Date.now()) return hit.value;
  const existing = flights.get(url);
  if (existing) return existing;
  if (flights.size >= 16) throw new Error("El catálogo está atendiendo otras consultas. Reintenta en unos instantes.");
  const flight = (async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: "error", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Featherless HTTP ${response.status}. No se ha sustituido el catálogo por una lista parcial.`);
    const raw = await response.text();
    if (raw.length > 4 * 1024 * 1024) throw new Error("La página de Featherless excede el tamaño esperado.");
    const body = record(JSON.parse(raw));
    const pagination = record(body.pagination);
    if (!Array.isArray(body.items) || body.items.length > 100 || !Number.isSafeInteger(pagination.total_items)
      || !Number.isSafeInteger(pagination.total_pages) || !Number.isSafeInteger(pagination.current_page)) throw new Error("Contrato de catálogo Featherless desconocido.");
    const all = body.items.map(classifyFeatherlessModel);
    const facets: FeatherlessPage["facets"] = {};
    for (const key of FEATHERLESS_FACETS) {
      const buckets = record(body.facets)[key];
      facets[key] = Array.isArray(buckets) ? buckets.map(record).filter(b => typeof b.value === "string" && Number.isSafeInteger(b.count))
        .map(b => ({ value: b.value as string, count: b.count as number })) : [];
    }
    const value: FeatherlessPage = { items: all.filter(m => m.reason === "parameters" || m.reason === "exception"),
      pagination: pagination as unknown as FeatherlessPage["pagination"], facets, inspected: all.length,
      excluded: all.filter(m => m.reason === "excluded").length, unknown: all.filter(m => m.reason === "unknown").length,
      toolsUnsupported: all.filter(m => m.reason === "tools-unsupported").length, toolsUnverified: all.filter(m => m.reason === "tools-unverified").length,
      fetchedAt: new Date().toISOString(), source: url };
    pages.delete(url); pages.set(url, { expires: Date.now() + 120000, value });
    while (pages.size > 64) pages.delete(pages.keys().next().value!);
    return value;
  })();
  flights.set(url, flight);
  try { return await flight; } finally { flights.delete(url); }
}
