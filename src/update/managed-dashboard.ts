/** Estado durable del actualizador gestionado; nunca instala desde una consulta GET. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { atomicWriteFile } from "../config";
import { isProcessAlive } from "../lib/process-control";
import { buildWindowsElevatedArgumentList, resolveTrustedWindowsPowerShellExe } from "../lib/windows-elevation";
import { isNewer, writeFreshVersionCache } from "./notify";

export interface ManagedContext { root: string; manager: string; version: string; patchPending: boolean }
export interface ManagedJob {
  id: string; status: "running" | "succeeded" | "failed";
  phase: "queued" | "preparing" | "validating" | "activating" | "completed" | "failed";
  startedAt: string; updatedAt: string; lastActivityAt?: string; pid?: number;
  targetVersion: string; exitCode?: number | null; error?: string;
}
interface CachedCheck { latestVersion: string | null; checkedAt: string | null; error: string | null }
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = <T>(path: string): T | null => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; } };
const samePath = (a: string, b: string) => { try { return realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase(); } catch { return false; } };

/** Solo un bundle registrado puede acceder al gestor; un checkout normal sigue siendo normal. */
export function managedContext(moduleRoot = packageRoot, platform = process.platform, local = process.env.LOCALAPPDATA): ManagedContext | null {
  if (platform !== "win32" || !local) return null;
  const root = join(local, "AgentStack", "opencodex-catalog");
  const state = read<{ active?: { sourcePath: string; version: string; patchHash: string } }>(join(root, "state.json"));
  const active = state?.active;
  const manager = join(root, "manager", "tools", "Manage-OpenCodexCatalog.ps1");
  if (!active || !samePath(active.sourcePath, moduleRoot) || !existsSync(manager)) return null;
  const manifest = read<{ patchSha256?: string }>(join(root, "manager", "opencodex-catalog", "manifest.json"));
  return { root, manager, version: active.version, patchPending: !!manifest?.patchSha256 && manifest.patchSha256 !== active.patchHash };
}

/** Validación cerrada de versiones: nunca convertir texto remoto en un argumento ejecutable. */
export function stableManagedVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value);
}

let pending: Promise<void> | null = null;
let lastAttempt = 0;
const CHECK_INTERVAL = 15 * 60_000;
const RETRY_INTERVAL = 60_000;
export async function refreshManagedUpdate(ctx: ManagedContext): Promise<void> {
  if (pending) return pending;
  lastAttempt = Date.now();
  pending = (async () => {
    const path = join(ctx.root, "managed-update-check.json");
    const previous = read<CachedCheck>(path);
    try {
      // Consulta atómica acotada; no es un timeout total del instalador ni de sus pruebas.
      const response = await fetch("https://registry.npmjs.org/@bitkyc08%2fopencodex/latest", { signal: AbortSignal.timeout(30_000), redirect: "error" });
      if (!response.ok) throw new Error("registry_unavailable");
      const body = await response.json() as { version?: unknown };
      if (!stableManagedVersion(body.version)) throw new Error("registry_invalid_version");
      atomicWriteFile(path, JSON.stringify({ latestVersion: body.version, checkedAt: new Date().toISOString(), error: null }));
      writeFreshVersionCache("latest", body.version);
    } catch {
      // Conservar el último dato conocido pero declarar explícitamente que la nueva consulta falló.
      atomicWriteFile(path, JSON.stringify({ latestVersion: previous?.latestVersion ?? null, checkedAt: previous?.checkedAt ?? null, error: "registry_unavailable" }));
    }
  })().finally(() => { pending = null; });
  return pending;
}

export function readManagedJob(ctx: ManagedContext): ManagedJob | null {
  const path = join(ctx.root, "managed-dashboard-job.json");
  const job = read<ManagedJob>(path);
  // La única espera por edad corresponde al arranque atómico sin PID; nunca a un proceso vivo.
  const orphanedLaunch = job?.status === "running" && !job.pid && Date.now() - Date.parse(job.startedAt) > 30_000;
  if (job?.status === "running" && ((job.pid && !isProcessAlive(job.pid)) || orphanedLaunch)) {
    // Un worker muerto nunca deja la interfaz esperando indefinidamente.
    const failed: ManagedJob = { ...job, status: "failed", phase: "failed", updatedAt: new Date().toISOString(), error: "worker_interrupted" };
    atomicWriteFile(path, JSON.stringify(failed));
    return failed;
  }
  return job;
}

/** La GUI sondea este estado al abrir y cada cinco segundos; solo se consulta npm cada quince minutos. */
export async function managedUpdateStatus(forceCheck = false) {
  const ctx = managedContext();
  if (!ctx) return { managed: false as const };
  const path = join(ctx.root, "managed-update-check.json");
  let cached = read<CachedCheck>(path);
  const checked = Date.parse(cached?.checkedAt ?? "");
  if (forceCheck) await refreshManagedUpdate(ctx);
  else if ((!Number.isFinite(checked) || Date.now() - checked >= CHECK_INTERVAL || checked > Date.now()) && Date.now() - lastAttempt >= RETRY_INTERVAL) {
    void refreshManagedUpdate(ctx).catch(() => { /* el siguiente sondeo expone el estado, sin derribar el gateway */ });
  }
  cached = read<CachedCheck>(path);
  const latest = stableManagedVersion(cached?.latestVersion) ? cached.latestVersion : null;
  const job = readManagedJob(ctx);
  return { managed: true as const, currentVersion: ctx.version, latestVersion: latest,
    checkedAt: cached?.checkedAt ?? null, checking: !!pending, error: cached?.error ?? null,
    updateAvailable: !!latest && isNewer(latest, ctx.version, "latest"), patchPending: ctx.patchPending,
    canUpdate: !!latest && !cached?.error && job?.status !== "running" && (isNewer(latest, ctx.version, "latest") || ctx.patchPending),
    job: job ? { ...job, elapsedSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(job.startedAt)) / 1000)) } : null };
}

/** Selecciona latest en el servidor y lanza un worker independiente del listener Windows. */
export async function startManagedDashboardUpdate(revalidate: boolean) {
  const checked = await managedUpdateStatus(true);
  const ctx = managedContext();
  if (!ctx || !checked.managed) throw new Error("managed_unavailable");
  if (readManagedJob(ctx)?.status === "running") throw new Error("update_already_running");
  if (checked.error || !checked.latestVersion) throw new Error("registry_unavailable");
  if (!checked.canUpdate && !revalidate) throw new Error("already_latest");
  const target = checked.latestVersion;
  // Ni siquiera una revalidación autoriza un downgrade si el registro retrocede.
  if (target !== ctx.version && !isNewer(target, ctx.version, "latest")) throw new Error("downgrade_refused");
  const job: ManagedJob = { id: crypto.randomUUID(), status: "running", phase: "queued", targetVersion: target,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const path = join(ctx.root, "managed-dashboard-job.json");
  atomicWriteFile(path, JSON.stringify(job));
  try {
    const args = buildWindowsElevatedArgumentList([join(packageRoot, "src", "update", "managed-worker.ts"), job.id]);
    const quote = (v: string) => `'${v.replace(/'/g, "''")}'`;
    const command = `$p=Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${quote(args)} -WindowStyle Hidden -PassThru; if(!$p){exit 1}; Write-Output $p.Id`;
    const launched = spawnSync(resolveTrustedWindowsPowerShellExe(), ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, encoding: "utf8", timeout: 15_000 });
    const pid = Number(launched.stdout?.trim());
    if (launched.status !== 0 || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("worker_start_failed");
    const fresh = read<ManagedJob>(path) ?? job;
    atomicWriteFile(path, JSON.stringify({ ...fresh, pid }));
    return { ...fresh, pid };
  } catch {
    atomicWriteFile(path, JSON.stringify({ ...job, status: "failed", phase: "failed", error: "worker_start_failed" }));
    throw new Error("worker_start_failed");
  }
}
