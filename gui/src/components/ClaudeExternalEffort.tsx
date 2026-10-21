import { useId, useState } from "react";
import { useT } from "../i18n/shared";
import { Notice, Select } from "../ui";
import { readJsonOrThrow } from "../fetch-json";
import { useDataSurface } from "../data-surface";
import { setClientResourceData } from "../client-resource";
import "../styles/claude-external-effort.css";

interface ModelEffortRow {
  key: string; provider: string; modelId: string; label: string;
  efforts: string[]; selected: string | null; stale: boolean;
}

/** Un formulario explícito: cambiar un desplegable no altera el gateway hasta guardar. */
export default function ClaudeExternalEffort({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
  const t = useT(), id = useId();
  const [modelKey, setModelKey] = useState("");
  const [draft, setDraft] = useState<{ key: string; value: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<{ key: string; effort: string | null } | null>(null);
  const resourceKey = `claude-external-efforts:${apiBase}`;
  const resource = useDataSurface(resourceKey, [apiBase], async signal => {
    const result = await readJsonOrThrow<{ models: ModelEffortRow[] }>(await fetch(`${apiBase}/api/claude/external-efforts`, { signal }));
    if (!result || !Array.isArray(result.models) || result.models.some(row =>
      !row || typeof row.key !== "string" || typeof row.provider !== "string" || typeof row.modelId !== "string"
      || typeof row.label !== "string" || !Array.isArray(row.efforts) || row.efforts.some(effort => typeof effort !== "string")
      || (row.selected !== null && typeof row.selected !== "string") || typeof row.stale !== "boolean")) throw new Error("Invalid effort state");
    return result;
  }, { isEmpty: result => result.models.length === 0, enabled: active, pollMs: 5000, pauseWhenHidden: true });
  const rows = resource.state.data?.models ?? [];
  const currentKey = rows.some(item => item.key === modelKey) ? modelKey : rows[0]?.key ?? "";
  const row = rows.find(item => item.key === currentKey);
  const choice = draft?.key === currentKey ? draft.value : row?.selected ?? "";
  const loading = resource.state.showSkeleton;
  const visibleError = error || (resource.state.showError ? t("claudeEffort.loadError") : "");
  async function save() {
    if (!row || saving) return;
    setSaving(true); setError(""); setSaved(null);
    try {
      await readJsonOrThrow(await fetch(`${apiBase}/api/claude/external-efforts`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: row.provider, modelId: row.modelId, effort: choice || null }),
      }));
      // La lectura posterior acredita persistencia, no basta un mensaje de éxito local.
      const state = await readJsonOrThrow<{ models: ModelEffortRow[] }>(await fetch(`${apiBase}/api/claude/external-efforts`));
      if (!state || state.models.find(item => item.key === row.key)?.selected !== (choice || null)) throw new Error();
      // Invalida lecturas antiguas y notifica otras instancias del panel sin pisar borradores.
      setClientResourceData(resourceKey, state); setDraft(null); setSaved({ key: row.key, effort: choice || null });
    } catch { setError(t("claudeEffort.saveError")); }
    finally { setSaving(false); }
  }
  const binary = row?.efforts.length === 2 && row.efforts.includes("none") && row.efforts.includes("high");
  const options = [{ value: "", label: t("claudeEffort.client") }, ...(row?.efforts ?? []).map(value => ({
    value, label: value === "none" ? t("claudeEffort.off") : binary ? t("claudeEffort.on") : value,
  }))];
  return <section className="card claude-external-effort" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`} className="text-subtitle font-semibold">{t("claudeEffort.title")}</h3>
    <p className="muted text-body">{t("claudeEffort.description")}</p>
    {loading ? <p role="status">{t("claudeEffort.loading")}</p> : <>
      {rows.length === 0 ? <p>{t("claudeEffort.empty")}</p> : <div className="claude-external-effort-controls">
        <div><label htmlFor={`${id}-model`}>{t("claudeEffort.model")}</label>
          <Select id={`${id}-model`} value={currentKey} disabled={saving} options={rows.map(item => ({ value: item.key, label: item.label }))} onChange={key => { setModelKey(key); setDraft(null); setSaved(null); }} /></div>
        <div><label htmlFor={`${id}-level`}>{t("claudeEffort.level")}</label>
          <Select id={`${id}-level`} value={choice} disabled={saving || !row} options={options} onChange={value => { setDraft({ key: currentKey, value }); setSaved(null); }} /></div>
        <button className="btn btn-primary" type="button" disabled={saving || !row || choice === (row.selected ?? "") || (!!choice && !row.efforts.includes(choice))} onClick={() => void save()}>{t("claudeEffort.save")}</button>
      </div>}
      {row && <p className="muted text-label">{t("claudeEffort.current", { effort: options.find(option => option.value === (row.selected ?? ""))?.label ?? row.selected ?? "" })}</p>}
      {row && row.efforts.length === 0 && <p className="muted text-body">{t("claudeEffort.unknown")}</p>}
      {row?.stale && <Notice tone="warn">{t("claudeEffort.stale")}</Notice>}
      {row?.selected && <p className="text-body">{t("claudeEffort.nativeNote")}</p>}
    </>}
    {visibleError && <><Notice tone="err">{visibleError}</Notice><button className="btn btn-ghost" type="button" disabled={loading || saving} onClick={() => { setError(""); resource.refresh(); }}>{t("common.retry")}</button></>}
    {saved && row && saved.key === row.key && saved.effort === row.selected && <Notice tone="ok">{t("claudeEffort.saved")}</Notice>}
  </section>;
}
