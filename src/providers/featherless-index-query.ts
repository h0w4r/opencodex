import { FEATHERLESS_FACETS, type FeatherlessModel, type FeatherlessPage } from "./featherless-catalog";

/** Facetas propias del universo admitido, nunca contadores del catálogo completo. */
export function queryFeatherlessIndex(models: FeatherlessModel[], input: URLSearchParams): FeatherlessPage {
  const search = (input.get("query") ?? "").trim().toLowerCase();
  const recency = Number(input.get("release_recency") ?? 0);
  const after = recency ? Date.now() - recency * 86400000 : 0;
  const base = models.filter(m => (!search || m.id.toLowerCase().includes(search))
    && (!after || (m.releasedAt !== null && Date.parse(m.releasedAt) >= after)));
  const matches = (model: FeatherlessModel, except?: string) => FEATHERLESS_FACETS.every(key => {
    const selected = input.getAll(key);
    return key === except || !selected.length || selected.some(value => model.tags[key]?.includes(value));
  });
  const facets: FeatherlessPage["facets"] = {};
  for (const key of FEATHERLESS_FACETS) {
    const counts = new Map<string, number>();
    for (const model of base) if (matches(model, key)) for (const value of new Set(model.tags[key] ?? [])) counts.set(value, (counts.get(value) ?? 0) + 1);
    facets[key] = [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }
  const found = base.filter(model => matches(model));
  const sort = input.get("sort") ?? "-downloads";
  const score = (m: FeatherlessModel) => sort === "-downloads" ? m.downloads : sort === "-favorites" ? m.favorites
    : sort === "-parameter_size" ? m.parameterSize ?? 0 : sort === "-hf_created_at" ? Date.parse(m.releasedAt ?? "") || 0 : null;
  // Cuando el origen no publica puntuación, conserva el orden de sus conjuntos
  // selectivos. No inventa un trending_rank ni una valoración numérica.
  if (!input.has("prioritize_warm") && score(found[0] ?? {} as FeatherlessModel) !== null) found.sort((a, b) => score(b)! - score(a)! || a.id.localeCompare(b.id));
  const page = Number(input.get("page") ?? 1);
  return { items: found.slice((page - 1) * 100, page * 100),
    pagination: { current_page: page, per_page: 100, total_items: found.length, total_pages: Math.max(1, Math.ceil(found.length / 100)) },
    facets, inspected: Math.min(100, Math.max(0, found.length - (page - 1) * 100)), excluded: 0, unknown: 0,
    toolsUnsupported: 0, toolsUnverified: 0, fetchedAt: "", source: "featherless-admitted-index" };
}

/** Mantiene los intervalos publicados; sus contadores se recalculan tras admisión. */
export function parameterBucket(size: number | null, buckets: string[]): string[] {
  if (size === null) return [];
  for (const bucket of buckets) {
    const match = bucket.match(/^(<?)\s*(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?([BT])(\+?)$/);
    if (!match) continue;
    const unit = match[4] === "T" ? 1e12 : 1e9;
    const min = Number(match[2]) * unit;
    const max = (Number(match[3] ?? match[2]) + 1) * unit;
    if (match[1] ? size < min : match[5] ? size > min : size >= min && size < max) return [bucket];
  }
  return [];
}
