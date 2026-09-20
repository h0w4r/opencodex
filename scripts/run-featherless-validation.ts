/** Ejecuta el servidor real con homes aislados; nunca escribe en el perfil nativo de Codex. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const destination = resolve(".tmp/featherless-live-home");
const nativeHome = resolve(".tmp/featherless-native-home");
const port = Number(process.env.OPENCODEX_VALIDATION_PORT ?? 10101);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Puerto de validación inválido.");
mkdirSync(destination, { recursive: true }); mkdirSync(nativeHome, { recursive: true });
const real = JSON.parse(readFileSync(join(homedir(), ".opencodex", "config.json"), "utf8"));
const provider = real.providers?.featherless;
if (!provider?.apiKey || provider.baseUrl !== "https://api.featherless.ai/v1") throw new Error("Falta el proveedor real Featherless esperado.");
// Sólo copia la credencial necesaria al home local ignorado y endurecido por el servidor.
if (!existsSync(join(destination, "config.json"))) writeFileSync(join(destination, "config.json"), JSON.stringify({
  port, hostname: "127.0.0.1", defaultProvider: "featherless", providers: { featherless: provider },
  clientIntegrations: { codex: false, grok: false, "claude-desktop": false },
  codexAutoStart: false, codexShimAutoRestore: false, syncResumeHistory: false,
}, null, 2));
process.env.OPENCODEX_HOME = destination;
process.env.CODEX_HOME = nativeHome;
const { startServer } = await import("../src/server");
startServer(port);
console.log(`Validación real aislada: http://127.0.0.1:${port}/#models/featherless`);
