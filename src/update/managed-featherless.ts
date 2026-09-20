import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

/** Actualiza el bundle versionado sin sobrescribir binarios activos ni perder la ampliación local. */
export async function runManagedFeatherlessUpdate(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const local = process.env.LOCALAPPDATA;
  const windows = process.env.SystemRoot;
  if (!local || !windows) throw new Error("No se pudo resolver el actualizador de catálogo para Windows.");
  const manager = join(local, "AgentStack", "opencodex-catalog", "manager", "tools", "Manage-OpenCodexCatalog.ps1");
  if (!existsSync(manager)) throw new Error("Este build incluye el catálogo Featherless. Instala su gestor o usa una distribución oficial independiente; no se sobrescribirá la ampliación con una actualización sin validar.");
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", manager, "-Action", "Update"],
      { stdio: "inherit", windowsHide: true });
    child.on("error", reject); child.on("exit", resolve);
  });
  if (code !== 0) throw new Error("No se activó la actualización. Revisa el informe de ocx-catalog status; el gestor conserva el último bundle funcional.");
  return true;
}
