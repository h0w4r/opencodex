/** Regresiones unitarias del límite gestionado; no sustituyen el gate real de navegador/servicio. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedContext, readManagedJob, refreshManagedUpdate, stableManagedVersion, type ManagedContext } from "../../src/update/managed-dashboard";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function context(): { ctx: ManagedContext; local: string; source: string } {
  const local = mkdtempSync(join(tmpdir(), "ocx-managed-status-")); folders.push(local);
  const root = join(local, "AgentStack", "opencodex-catalog");
  const manager = join(root, "manager", "tools", "Manage-OpenCodexCatalog.ps1");
  const source = join(root, "releases", "registered");
  mkdirSync(join(root, "manager", "tools"), { recursive: true });
  mkdirSync(join(root, "manager", "opencodex-catalog"), { recursive: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(manager, "# gestor de prueba unitaria");
  writeFileSync(join(root, "state.json"), JSON.stringify({ active: { sourcePath: source, version: "2.88.0", patchHash: "A" } }));
  writeFileSync(join(root, "manager", "opencodex-catalog", "manifest.json"), JSON.stringify({ patchSha256: "B" }));
  return { ctx: { root, manager, version: "2.88.0", patchPending: true }, local, source };
}
test("solo reconoce el bundle activo registrado en Windows", () => {
  const { local, source } = context();
  expect(managedContext(source, "win32", local)?.patchPending).toBe(true);
  expect(managedContext(source, "linux", local)).toBeNull();
  expect(managedContext(local, "win32", local)).toBeNull();
});
test("rechaza versiones no estables y texto ejecutable", () => {
  for (const value of ["latest", "2.89.0-preview.1", "2.89.0; calc.exe", "../2.89.0", null]) expect(stableManagedVersion(value)).toBe(false);
  expect(stableManagedVersion("2.89.0")).toBe(true);
});
test("recupera un worker muerto pero nunca cancela uno vivo por antigüedad", () => {
  const { ctx } = context();
  const path = join(ctx.root, "managed-dashboard-job.json");
  const job = { id: "test", status: "running", phase: "preparing", pid: process.pid, updatedAt: "2000-01-01", startedAt: "2000-01-01", targetVersion: "2.88.0" };
  writeFileSync(path, JSON.stringify(job));
  expect(readManagedJob(ctx)?.status).toBe("running");
  writeFileSync(path, JSON.stringify({ ...job, pid: 2147483647 }));
  expect(readManagedJob(ctx)).toMatchObject({ status: "failed", error: "worker_interrupted" });
  // Un corte antes de registrar el PID tampoco puede dejar la GUI ocupada para siempre.
  writeFileSync(path, JSON.stringify({ ...job, pid: undefined }));
  expect(readManagedJob(ctx)).toMatchObject({ status: "failed", error: "worker_interrupted" });
});
test("la consulta real al registro conserva una versión estable verificable", async () => {
  const { ctx } = context();
  await refreshManagedUpdate(ctx);
  const cached = JSON.parse(await Bun.file(join(ctx.root, "managed-update-check.json")).text());
  // Dependencia real: si el registro no responde, la prueba falla explícitamente.
  expect(cached.error).toBeNull();
  expect(stableManagedVersion(cached.latestVersion)).toBe(true);
}, 45_000);
