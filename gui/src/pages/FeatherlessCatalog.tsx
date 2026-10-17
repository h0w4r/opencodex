import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { FeatherlessFilters } from "./featherless-filters";
import { compactNumber, FL_STATE_KEY, initialFeatherlessQuery, type FeatherlessResult, type FeatherlessRow } from "./featherless-types";
import "./featherless-catalog.css";

const SORTS = [["-downloads", "fl.sort.downloads"], ["-trending_rank", "fl.sort.trending"], ["-favorites", "fl.sort.favorites"],
  ["-hf_created_at", "fl.sort.newest"], ["-parameter_size", "fl.sort.size"], ["-avg_rating", "fl.sort.rating"]] as const;

/** Búsqueda remota paginada: no descarga ni renderiza decenas de miles de filas por interacción. */
export default function FeatherlessCatalog({ apiBase, active }: { apiBase: string; active: boolean }) {
  const t = useT();
  const [query, setQuery] = useState(initialFeatherlessQuery);
  const [search, setSearch] = useState(query.get("query") ?? "");
  const [pageInput, setPageInput] = useState(query.get("page") ?? "1");
  const [result, setResult] = useState<FeatherlessResult | null>(null);
  const [settled, setSettled] = useState("");
  const [error, setError] = useState("");
  const [provider, setProvider] = useState("");
  const [saving, setSaving] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [progress, setProgress] = useState<{ pages: number; admitted: number } | null>(null);
  const generation = useRef(0);
  const serialized = query.toString();
  const searchedQuery = query.get("query") ?? "";
  const requestKey = `${serialized}:${refresh}`;
  const loading = active && settled !== requestKey;

  const change = useCallback((key: string, value: string, multiple = false) => {
    setPageInput(key === "page" ? value : "1");
    setQuery(old => {
      const next = new URLSearchParams(old);
      if (multiple) {
        const values = new Set(next.getAll(key));
        if (values.has(value)) values.delete(value); else values.add(value);
        next.delete(key); for (const item of values) next.append(key, item);
      } else { next.delete(key); if (value) next.set(key, value); }
      if (key !== "page") next.delete("page");
      return next;
    });
  }, []);

  useEffect(() => {
    if (search === searchedQuery) return;
    const timer = window.setTimeout(() => change("query", search.trim()), 400);
    return () => window.clearTimeout(timer);
  }, [search, searchedQuery, change]);

  useEffect(() => {
    if (!active) return;
    const current = ++generation.current;
    const controller = new AbortController();
    let poll: number | undefined;
    try { sessionStorage.setItem(FL_STATE_KEY, serialized); } catch { /* La navegación funciona sin almacenamiento. */ }
    fetch(`${apiBase}/api/featherless/models?${serialized}`, { signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (generation.current !== current) return;
        if (body.pending && generation.current === current) {
          setProgress(body.progress); setError(""); setResult(null);
          poll = window.setTimeout(() => setRefresh(v => v + 1), 1500);
          return;
        }
        setProgress(null);
        if (generation.current === current) { setResult(body); setError(""); setProvider(previous => body.providers.includes(previous) ? previous : body.providers[0] ?? ""); }
      }).catch(reason => { if (!controller.signal.aborted && generation.current === current) setError(String(reason.message ?? reason)); })
      .finally(() => { if (generation.current === current) setSettled(requestKey); });
    return () => { controller.abort(); window.clearTimeout(poll); };
  }, [apiBase, active, serialized, requestKey]);

  async function select(model: FeatherlessRow, enabled: boolean) {
    setSaving(model.id); setError("");
    try {
      const response = await fetch(`${apiBase}/api/featherless/selection`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: model.id, provider, enabled }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setRefresh(v => v + 1);
    } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); }
    finally { setSaving(""); }
  }

  const pagination = result?.pagination;
  const currentPage = Number(query.get("page") ?? 1);
  return <section className="fl-catalog" aria-label={t("models.tab.featherless")}>
    <p className="fl-policy"><strong>{t("fl.restrictions")}</strong> {t("fl.policy")}</p>
    <div className="fl-toolbar">
      <input type="search" aria-label={t("fl.searchLabel")} placeholder={t("fl.search")} value={search} onChange={e => setSearch(e.target.value)} />
      <label>{t("fl.sort")}<select value={query.get("sort") ?? SORTS[0][0]} onChange={e => change("sort", e.target.value)}>{SORTS.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select></label>
      <button type="button" onClick={() => { setSearch(""); setPageInput("1"); setQuery(new URLSearchParams()); }}>{t("fl.reset")}</button>
    </div>
    <button type="button" className="fl-filter-toggle" aria-expanded={filtersOpen} aria-controls="featherless-filter-panel" onClick={() => setFiltersOpen(v => !v)}>{t("fl.showFilters")}</button>
    <div className="fl-layout">
      <div id="featherless-filter-panel" className={`fl-filters-wrap${filtersOpen ? " is-open" : ""}`}><FeatherlessFilters query={query} facets={result?.facets ?? {}} change={change} /></div>
      <div className="fl-results">
        {provider ? <label className="fl-provider">{t("fl.provider")}<select value={provider} onChange={e => setProvider(e.target.value)}>{result?.providers.map(p => <option key={p}>{p}</option>)}</select></label> : <p>{t("fl.noProvider")}</p>}
        <div role="status" aria-live="polite">{progress ? t("fl.indexing", { pages: progress.pages, admitted: progress.admitted }) : loading ? t("fl.loading") : pagination ? t("fl.counts", { total: pagination.total_items.toLocaleString(), page: pagination.current_page, pages: pagination.total_pages, shown: result!.items.length, admitted: result!.catalog.total.toLocaleString() }) : null}</div>
        <details className="fl-note"><summary>{t("fl.countHelp")}</summary><p>{t("fl.countNote")}</p></details>
        {result && <p className="fl-note">{t("fl.snapshot")} <time className="fl-snapshot-time" dateTime={result.fetchedAt}>{result.fetchedAt}</time>{result.catalog.refreshing ? ` · ${t("fl.refreshing")}` : ""}</p>}
        {result?.catalog.error && <p role="alert" className="fl-error">{t("fl.refreshFailed")}: {result.catalog.error}</p>}
        {error && !loading && <div role="alert" className="fl-error"><p>{t("fl.error")}</p><p>{error}</p><button type="button" onClick={() => setRefresh(v => v + 1)}>{t("fl.retry")}</button></div>}
        {!loading && !error && result?.items.length === 0 && <p>{t("fl.empty")}</p>}
        <div className="fl-models" aria-busy={loading}>
          {!error && !loading && result?.items.map(model => {
            const enabled = result.enabled[provider]?.includes(model.id) ?? false;
            return <article className="fl-model" key={model.id}>
              <h3><a href={`https://featherless.ai/models/${model.id.split("/").map(encodeURIComponent).join("/")}`} target="_blank" rel="noreferrer" title={t("fl.open")}>{model.id}</a></h3>
              <dl><div><dt>{t("fl.parameters")}</dt><dd>{compactNumber(model.parameterSize)}</dd></div><div><dt>{t("fl.context")}</dt><dd>{compactNumber(model.contextLength)}</dd></div>
                <div><dt>{t("fl.tools")}</dt><dd>{t(model.toolUse === null ? "fl.unknown" : model.toolUse ? "fl.yes" : "fl.no")}</dd></div><div><dt>{t("fl.status")}</dt><dd>{model.status}</dd></div></dl>
              <div className="fl-model-footer"><span>{t(model.reason === "parameters" ? "fl.reason.parameters" : "fl.reason.exception")}</span>
                <button type="button" aria-pressed={enabled} aria-label={`${t(enabled ? "fl.disable" : "fl.enable")}: ${model.id}`} disabled={!provider || !!saving} onClick={() => select(model, !enabled)}>{t(saving === model.id ? "fl.saving" : enabled ? "fl.enabled" : "fl.enable")}</button>
              </div>
              <details><summary>{t("fl.evidence")}</summary><ul>{[...model.toolEvidence, ...model.evidence].map(e => <li key={e}>{e}</li>)}</ul></details>
            </article>;
          })}
        </div>
        <form className="fl-pagination" onSubmit={event => { event.preventDefault(); const n = Number(pageInput); if (Number.isSafeInteger(n) && n >= 1 && (!pagination || n <= pagination.total_pages)) change("page", String(n)); }}>
          <button type="button" disabled={loading || currentPage <= 1} onClick={() => change("page", String(currentPage - 1))}>{t("fl.previous")}</button>
          <label>{t("fl.page")}<input type="number" min="1" max={pagination?.total_pages || 1} value={pageInput} onChange={e => setPageInput(e.target.value)} /></label>
          <button type="submit" disabled={loading}>{t("fl.go")}</button>
          <button type="button" disabled={loading || !pagination || currentPage >= pagination.total_pages} onClick={() => change("page", String(currentPage + 1))}>{t("fl.next")}</button>
        </form>
        <p className="fl-note">{t("fl.planNote")}</p>
      </div>
    </div>
  </section>;
}
