import { useState } from "react";
import { useT, type TKey } from "../i18n/shared";
import type { FeatherlessResult } from "./featherless-types";

const GROUPS = {
  main: ["modalities", "parameter_bucket", "family", "capabilities", "popularity_level"],
  architecture: ["architectures"], language: ["languages"], domain: ["domains", "creative"],
  trainingTab: ["training"], licenseTab: ["license"],
} as const;

function Facet({ name, buckets, selected, toggle, clear }: {
  name: string; buckets: Array<{ value: string; count: number }>; selected: string[]; toggle: (value: string) => void; clear: () => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [alphabetical, setAlphabetical] = useState(false);
  const found = buckets.filter(b => b.value.toLowerCase().includes(search.toLowerCase()));
  if (alphabetical) found.sort((a, b) => a.value.localeCompare(b.value));
  // Sólo se renderiza el grupo activo, con expansión explícita de vocabularios grandes.
  const visible = expanded || search ? found : found.slice(0, 14);
  return <fieldset className="fl-facet">
    <legend>{t(`fl.${name}` as TKey)}</legend>
    <button type="button" disabled={!selected.length} onClick={clear}>{t("fl.clearFacet")}</button>
    <button type="button" aria-label={t("fl.facetOrder")} aria-pressed={alphabetical} onClick={() => setAlphabetical(!alphabetical)}>{t("fl.alphabetical")}</button>
    <input aria-label={`${t("fl.filterSearch")}: ${t(`fl.${name}` as TKey)}`} value={search} onChange={e => setSearch(e.target.value)} placeholder={t("fl.filterSearch")} />
    <div className="fl-buckets">
      {visible.map(b => <button type="button" key={b.value} aria-pressed={selected.includes(b.value)} onClick={() => toggle(b.value)}>
        <span>{name === "popularity_level" && /^[0-5]$/.test(b.value) ? t(`fl.popularity.${b.value}` as TKey) : b.value}</span><small>{b.count.toLocaleString()}</small>
      </button>)}
    </div>
    {found.length > 14 && !search && <button type="button" className="fl-expand" onClick={() => setExpanded(!expanded)}>{t(expanded ? "fl.less" : "fl.more")}</button>}
  </fieldset>;
}

export function FeatherlessFilters({ query, facets, change }: {
  query: URLSearchParams; facets: FeatherlessResult["facets"]; change: (key: string, value: string, multiple?: boolean) => void;
}) {
  const t = useT();
  const [group, setGroup] = useState<keyof typeof GROUPS>("main");
  return <aside className="fl-filters">
    <div className="fl-groups" role="group" aria-label={t("fl.filterSearch")}>
      {Object.keys(GROUPS).map(key => <button type="button" key={key} aria-pressed={group === key} onClick={() => setGroup(key as keyof typeof GROUPS)}>{t(`fl.${key}` as TKey)}</button>)}
    </div>
    {GROUPS[group].map(name => <Facet key={name} name={name} buckets={facets[name] ?? []} selected={query.getAll(name)} toggle={v => change(name, v, true)} clear={() => change(name, "")} />)}
    {group === "main" && <>
      <fieldset className="fl-facet"><legend>{t("fl.availability")}</legend>
        {([["featherless_exclusive", "fl.exclusive"], ["trending", "fl.trending"], ["prioritize_warm", "fl.warm"]] as const).map(([key, label]) => <label className="fl-check" key={key}>
          <input type="checkbox" checked={query.get(key) === "true"} onChange={e => change(key, e.target.checked ? "true" : "")} />{t(label)}
        </label>)}
      </fieldset>
      <label className="fl-facet">{t("fl.recency")}<select value={query.get("release_recency") ?? ""} onChange={e => change("release_recency", e.target.value)}>
        <option value="">{t("fl.anyDate")}</option>
        {[30, 90, 180, 365].map(days => <option key={days} value={days}>{t("fl.days", { days })}</option>)}
      </select></label>
    </>}
  </aside>;
}
