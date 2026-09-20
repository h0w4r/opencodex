/** Adopción explícita: modifica sólo el modo de descubrimiento del proveedor oficial, usando el writer upstream. */
import { loadConfig, saveConfigPreservingClaudeCode } from "../src/config";
import { isFeatherlessCatalogProvider } from "../src/providers/featherless-catalog";
const config = loadConfig();
const names: string[] = [];
for (const [name, provider] of Object.entries(config.providers)) {
  if (!isFeatherlessCatalogProvider(provider)) continue;
  provider.liveModels = false;
  names.push(name);
}
saveConfigPreservingClaudeCode(config);
console.log(JSON.stringify({ adaptedProviders: names, credentialsChanged: false }));
