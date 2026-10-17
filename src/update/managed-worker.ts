/** Worker oculto: mantiene el trabajo al reiniciarse el gateway y publica solo estados seguros. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, loadConfig } from "../config";
import { resolveTrustedWindowsPowerShellExe } from "../lib/windows-elevation";
import { managedContext, stableManagedVersion, type ManagedJob } from "./managed-dashboard";

const ctx = managedContext();
const id = process.argv[2];
if (!ctx || !/^[0-9a-f-]{36}$/.test(id ?? "")) throw new Error("managed_worker_invalid_context");
const path = join(ctx.root, "managed-dashboard-job.json");
const initial = JSON.parse(readFileSync(path, "utf8")) as ManagedJob;
if (initial.id !== id || !stableManagedVersion(initial.targetVersion)) throw new Error("managed_worker_invalid_job");
let job: ManagedJob = { ...initial, pid: process.pid, phase: "preparing" };
let failureCode = "manager_failed";
function publish(patch: Partial<ManagedJob> = {}) {
  job = { ...job, ...patch, updatedAt: new Date().toISOString() };
  atomicWriteFile(path, JSON.stringify(job));
}
publish();
try {
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(resolveTrustedWindowsPowerShellExe(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ctx.manager, "-Action", "Update", "-Version", job.targetVersion], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    // La salida puede contener rutas privadas: clasificar, nunca reflejar texto libre en la API.
    const activity = (chunk: Buffer) => {
      const value = chunk.toString("utf8");
      if (/patch does not apply|patch failed|corrupt patch/i.test(value)) failureCode = "patch_incompatible";
      const phase = /Activación:|Servicio verificado|service installed/.test(value) ? "activating"
        : /typecheck|\(pass\)|"phase"|oxlint|built in|test\]/.test(value) && job.phase !== "activating" ? "validating" : job.phase;
      publish({ phase, lastActivityAt: new Date().toISOString() });
    };
    child.stdout.on("data", activity); child.stderr.on("data", activity);
    child.once("error", reject); child.once("exit", resolve);
    // No timeout total: el gestor y sus pasos administran conexiones y actividad reales.
  });
  if (code !== 0) { publish({ status: "failed", phase: "failed", exitCode: code, error: failureCode }); process.exitCode = 1; }
  else {
    const state = JSON.parse(readFileSync(join(ctx.root, "state.json"), "utf8"));
    const health = await fetch(`http://127.0.0.1:${loadConfig().port}/healthz`, { signal: AbortSignal.timeout(15_000) });
    const body = await health.json() as { status?: string; version?: string };
    if (!health.ok || body.status !== "ok" || body.version !== job.targetVersion || state.active?.version !== job.targetVersion) throw new Error("activation_not_verified");
    publish({ status: "succeeded", phase: "completed", exitCode: 0 });
  }
} catch { publish({ status: "failed", phase: "failed", error: "activation_not_verified" }); process.exitCode = 1; }
