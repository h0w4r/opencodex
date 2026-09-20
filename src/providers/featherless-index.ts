/** Índice persistente de modelos admitidos. La GUI jamás recibe el universo descartado. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { atomicWriteFileAsync } from "../config/atomic-write";
import { FEATHERLESS_EXCEPTION, applyFeatherlessToolProof, classifyFeatherlessModel, fetchFeatherlessSourcePage, featherlessSearchUrl, type FeatherlessModel, type FeatherlessPage } from "./featherless-catalog";
import { fingerprintFeatherlessCapabilityEvidence, loadFeatherlessCapabilityEvidence, type FeatherlessCapabilityProof } from "./featherless-capability-evidence";
import { parameterBucket, queryFeatherlessIndex } from "./featherless-index-query";

const BASE_POLICY = "16B-or-declared-exception-and-declared-or-runtime-tools-v5";
const TTL = 6 * 60 * 60 * 1000;
// Estos términos encuentran nombres que carecen de etiquetas; el clasificador
// sigue validando el nombre específico y nunca acepta por coincidencia del autor.
const NAME_SEARCHES = ["uncensor", "unfilter", "abliter", "obliter", "censor", "restrict", "align", "refusal", "jailbroken", "cyber", "security", "pentest", "penetration", "offsec", "vulnerability", "malware", "red-team", "redteam", "red_team"];
interface Snapshot { policy: string; at: string; models: FeatherlessModel[]; sourcePages: number }
interface Progress { pages: number; admitted: number; phase: string }
interface State { snapshot?: Snapshot; flight?: Promise<void>; error?: string; failedAt?: number; progress: Progress }
const states = new Map<string, State>();
export class FeatherlessIndexPending extends Error {
  constructor(public progress: Progress) { super("Preparando el catálogo admitido."); }
}

function variant(input: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams();
  const sort = input.get("sort");
  if (sort === "-trending_rank" || sort === "-avg_rating") params.set("sort", sort);
  for (const key of ["featherless_exclusive", "trending", "prioritize_warm"]) if (input.get(key) === "true") params.set(key, "true");
  return params;
}

async function build(parameters: URLSearchParams, state: State, proofs: Map<string, FeatherlessCapabilityProof>, policy: string): Promise<Snapshot> {
  const accepted = new Map<string, FeatherlessModel>();
  const plans: Array<{ query: URLSearchParams; min?: number }> = [];
  const buckets = new Set<string>();
  const tags = new Map<string, Set<string>>();
  const base = new URLSearchParams(parameters); base.set("sort", parameters.get("sort") ?? "-downloads");
  const consume = async (query: URLSearchParams, min?: number) => {
    let lastPage = 1;
    for (let page = 1; page <= lastPage; page++) {
      query.set("page", String(page));
      const data = await fetchFeatherlessSourcePage(query, { min });
      lastPage = data.pagination.total_pages;
      for (const bucket of data.facets.parameter_bucket ?? []) buckets.add(bucket.value);
      for (const key of ["training", "domains", "capabilities"]) for (const bucket of data.facets[key] ?? []) {
        if (FEATHERLESS_EXCEPTION.test(bucket.value) || (key === "domains" && bucket.value === "security")) {
          if (!tags.has(key)) tags.set(key, new Set()); tags.get(key)!.add(bucket.value);
        }
      }
      for (const model of data.items) if (!accepted.has(model.id)) accepted.set(model.id, model);
      state.progress.pages++; state.progress.admitted = accepted.size;
      if (state.progress.pages % 10 === 0) console.info(`[featherless-catalog] pages=${state.progress.pages} admitted=${accepted.size} phase=${state.progress.phase}`);
    }
  };
  // Nunca se pagina por el catálogo general: primero >=16B + tools en origen,
  // después sólo candidatos de excepción + tools, con deduplicación por ID exacto.
  state.progress.phase = "parameters";
  await consume(new URLSearchParams(base), 16);
  for (const [key, values] of tags) {
    const query = new URLSearchParams(base); for (const value of values) query.append(key, value);
    plans.push({ query });
  }
  for (const name of NAME_SEARCHES) { const query = new URLSearchParams(base); query.set("query", name); plans.push({ query }); }
  state.progress.phase = "exceptions";
  // Dos consultas activas limitan carga y cuota; cada página renueva actividad.
  let cursor = 0;
  let failed = false;
  const workers = await Promise.allSettled([0, 1].map(async () => {
    try { while (!failed && cursor < plans.length) { const plan = plans[cursor++]; await consume(plan.query, plan.min); } }
    catch (error) { failed = true; throw error; }
  }));
  const failure = workers.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
  state.progress.phase = "runtime-evidence";
  const runtimeProofs = [...proofs.values()];
  // La lista probada suele ser pequeña; dos lectores evitan una ráfaga contra
  // el endpoint de detalle y no recorren el catálogo general de 49.000 modelos.
  let proofCursor = 0;
  const proofWorkers = await Promise.allSettled([0, 1].map(async () => {
    while (proofCursor < runtimeProofs.length) {
      const proof = runtimeProofs[proofCursor++];
      const model = await fetchProvenModel(proof);
      if (model && !accepted.has(model.id)) accepted.set(model.id, model);
      state.progress.admitted = accepted.size;
    }
  }));
  const proofFailure = proofWorkers.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (proofFailure) throw proofFailure.reason;
  const models = [...accepted.values()];
  for (const model of models) model.tags.parameter_bucket = parameterBucket(model.parameterSize, [...buckets]);
  // Popularidad se calcula dentro del universo admitido, no entre 49.000 modelos.
  const popular = [...models].sort((a, b) => b.downloads - a.downloads || a.id.localeCompare(b.id));
  for (let rank = 0; rank < popular.length; rank++) {
    const quantile = rank / popular.length;
    popular[rank].tags.popularity_level = [String(quantile < .02 ? 5 : quantile < .1 ? 4 : quantile < .3 ? 3 : quantile < .6 ? 2 : quantile < .85 ? 1 : 0)];
  }
  state.progress.phase = "ready";
  return { policy, at: new Date().toISOString(), models, sourcePages: state.progress.pages };
}

async function fetchProvenModel(proof: FeatherlessCapabilityProof): Promise<FeatherlessModel | undefined> {
  const response = await fetch(`https://api.featherless.ai/v1/models/${proof.modelId.split("/").map(encodeURIComponent).join("/")}`,
    { redirect: "error", signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Metadatos de evidencia runtime: HTTP ${response.status}.`);
  const model = applyFeatherlessToolProof(classifyFeatherlessModel(await response.json()),
    `runtime:${proof.transport}:${proof.observedAt}`);
  return model.id === proof.modelId && model.status === "active"
    && (model.reason === "parameters" || model.reason === "exception") ? model : undefined;
}

function stateFor(input: URLSearchParams): { state: State; path: string; parameters: URLSearchParams; proofs: Map<string, FeatherlessCapabilityProof> } {
  const parameters = variant(input);
  const proofs = loadFeatherlessCapabilityEvidence();
  const policy = `${BASE_POLICY}:${fingerprintFeatherlessCapabilityEvidence(proofs)}`;
  const key = `${getConfigDir()}:${parameters}:${policy}`;
  let state = states.get(key);
  const cacheDir = join(getConfigDir(), "featherless-catalog");
  const hash = createHash("sha256").update(policy + parameters).digest("hex").slice(0, 24);
  const path = join(cacheDir, `${hash}.json`);
  if (!state) {
    if (states.size >= 8) {
      const idle = [...states].find(([, item]) => !item.flight);
      if (!idle) throw new Error("El catálogo está preparando otras vistas. Reintenta en unos instantes.");
      states.delete(idle[0]);
    }
    state = { progress: { pages: 0, admitted: 0, phase: "starting" } };
    if (existsSync(path)) {
      try {
        const stored = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
        if (stored.policy === policy && Array.isArray(stored.models) && Number.isFinite(Date.parse(stored.at))
          && stored.models.every(m => m.toolUse === true && (m.reason === "parameters" || m.reason === "exception"))) state.snapshot = stored;
      } catch { /* Una caché dañada se reconstruye; nunca se entrega como catálogo válido. */ }
    }
    states.set(key, state);
  }
  if (!state.flight && (!state.snapshot || Date.now() - Date.parse(state.snapshot.at) > TTL) && (!state.failedAt || Date.now() - state.failedAt > 60000)) {
    const current = state;
    current.progress = { pages: 0, admitted: 0, phase: "starting" };
    current.flight = build(parameters, current, proofs, policy).then(async snapshot => {
      mkdirSync(cacheDir, { recursive: true });
      await atomicWriteFileAsync(path, JSON.stringify(snapshot));
      current.snapshot = snapshot; current.error = undefined; current.failedAt = undefined;
    }).catch(error => { current.error = error instanceof Error ? error.message : "Falló la actualización del catálogo admitido."; current.failedAt = Date.now(); })
      .finally(() => { current.flight = undefined; });
  }
  return { state, path, parameters, proofs };
}

/** Los contadores, facetas y páginas sólo conocen el conjunto previamente admitido. */
export async function fetchFeatherlessPage(input: URLSearchParams): Promise<FeatherlessPage & { catalog: { total: number; refreshing: boolean; error?: string; sourcePages: number } }> {
  featherlessSearchUrl(input); // Valida parámetros antes de crear una tarea de caché.
  const { state } = stateFor(input);
  if (!state.snapshot) {
    if (state.error && !state.flight) throw new Error(state.error);
    throw new FeatherlessIndexPending({ ...state.progress });
  }
  const result = queryFeatherlessIndex(state.snapshot.models, input);
  return { ...result, fetchedAt: state.snapshot.at, catalog: { total: state.snapshot.models.length, refreshing: !!state.flight,
    error: state.error, sourcePages: state.snapshot.sourcePages } };
}

/** La selección sólo admite IDs del índice; una URL manipulada no amplía restricciones. */
export async function findFeatherlessModel(id: string): Promise<FeatherlessModel | undefined> {
  const { state, proofs } = stateFor(new URLSearchParams());
  if (!state.snapshot && state.flight) await state.flight;
  if (!state.snapshot) throw new Error(state.error ?? "Catálogo admitido aún no disponible.");
  if (!state.snapshot.models.some(model => model.id === id)) return undefined;
  // Revalida contra el detalle documentado: una retirada de soporte no queda
  // autorizada durante seis horas simplemente por existir en una caché anterior.
  const response = await fetch(`https://api.featherless.ai/v1/models/${id.split("/").map(encodeURIComponent).join("/")}`,
    { redirect: "error", signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Metadatos de selección: HTTP ${response.status}.`);
  let model = classifyFeatherlessModel(await response.json());
  const proof = proofs.get(id);
  if (proof) model = applyFeatherlessToolProof(model, `runtime:${proof.transport}:${proof.observedAt}`);
  return model.id === id && (model.reason === "parameters" || model.reason === "exception") ? model : undefined;
}

/** Preparación explícita para CLI y validación; espera actividad, no un timeout total. */
export async function warmFeatherlessIndex(input = new URLSearchParams()): Promise<void> {
  const { state } = stateFor(input);
  if (state.flight) await state.flight;
  if (!state.snapshot || state.error) throw new Error(state.error ?? "No existe un índice completo.");
}
