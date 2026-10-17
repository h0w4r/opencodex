/** Estado global persistido: comprobar es automático; instalar siempre requiere un clic. */
import { useEffect, useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { useT } from "../i18n/shared";
import { IconAlert, IconRefresh } from "../icons";

interface ManagedStatus {
  managed: boolean; currentVersion?: string; latestVersion?: string | null; checkedAt?: string | null;
  checking?: boolean; updateAvailable?: boolean; patchPending?: boolean; canUpdate?: boolean; error?: string | null;
  job?: { id: string; status: "running" | "succeeded" | "failed"; phase: string; elapsedSeconds?: number; startedAt: string; lastActivityAt?: string; error?: string } | null;
}

export function ManagedUpdateNotice({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // El botón oficial del sidebar abre este estado cuando la instalación es gestionada.
  useEffect(() => {
    const open = () => setExpanded(true);
    window.addEventListener("ocx-managed-update-open", open);
    return () => window.removeEventListener("ocx-managed-update-open", open);
  }, []);
  const poll = useKeyedClientResource(`managed-update:${apiBase}`, [apiBase], async signal => {
    const response = await fetch(`${apiBase}/api/update/managed`, { signal });
    if (!response.ok) throw new Error("managed_status_unavailable");
    return await response.json() as ManagedStatus;
  }, { pollMs: 5000 });
  const state = poll.data;
  // Versiones anteriores no tienen esta ruta; no atribuirles una capacidad ficticia.
  if (!state?.managed) return null;
  const running = state.job?.status === "running";
  const failed = state.job?.status === "failed";
  async function act(action: "check" | "update" | "revalidate") {
    setBusy(true); setError(false);
    try {
      const response = await fetch(`${apiBase}/api/update/managed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      if (!response.ok) throw new Error("managed_action_failed");
    } catch { setError(true); }
    finally { setBusy(false); poll.refresh(); }
  }
  const phase = state.job?.phase === "activating" ? t("managedUpdate.activating")
    : state.job?.phase === "validating" ? t("managedUpdate.validating") : t("managedUpdate.preparing");
  return <section className="managed-update notice" aria-label={t("managedUpdate.title")}>
    <div className="managed-update-summary">
      <IconRefresh />
      <strong>{t("managedUpdate.title")}</strong>
      <span className="mono">{state.currentVersion}{state.updateAvailable ? ` → ${state.latestVersion}` : ""}</span>
      <span role="status" aria-live="polite">{poll.error ? t("managedUpdate.reconnecting") : running ? phase : failed ? t("managedUpdate.failed") : state.checking ? t("managedUpdate.checking")
        : state.error ? t("managedUpdate.unavailable") : state.updateAvailable ? t("managedUpdate.available")
          : state.patchPending ? t("managedUpdate.customizations") : t("managedUpdate.current")}</span>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy || running || state.checking} onClick={() => { void act("check"); }}>{t("managedUpdate.check")}</button>
      {state.canUpdate && <button type="button" className="btn btn-primary btn-sm" disabled={busy || running} onClick={() => { void act("update"); }}>{t("managedUpdate.install")}</button>}
    </div>
    <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>{t("managedUpdate.details")}</summary>
      <p className="muted">{t("managedUpdate.protection")}</p>
      <p>{t("managedUpdate.latest")}: <span className="mono">{state.latestVersion ?? "—"}</span></p>
      <p>{t("managedUpdate.checked")}: {state.checkedAt ? new Date(state.checkedAt).toLocaleString() : "—"}</p>
      {state.job && <p role="status">{running ? phase : failed ? t("managedUpdate.failed") : t("managedUpdate.succeeded")}
        {running && ` · ${t("managedUpdate.elapsed", { seconds: state.job.elapsedSeconds ?? 0 })}`}</p>}
      {failed && state.job?.error === "patch_incompatible" && <p>{t("managedUpdate.incompatible")}</p>}
      {(failed || error) && <p className="notice notice-err" role="alert"><IconAlert />{t("managedUpdate.failureHelp")}</p>}
      {failed && <p><code>ocx-catalog Status</code></p>}
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy || running || state.checking || !!state.error} onClick={() => { void act("revalidate"); }}>{t("managedUpdate.revalidate")}</button>
    </details>
  </section>;
}
