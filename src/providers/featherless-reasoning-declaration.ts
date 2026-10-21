import { createHash } from "node:crypto";

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export interface ReasoningDeclaration {
  url: string;
  sha256: string;
  efforts: string[];
  defaultEffort?: string;
}

/** Lee datos declarativos, no ejecuta instrucciones ni código del repositorio del modelo. */
export function reasoningDeclarationFromCard(text: string, url: string): ReasoningDeclaration | undefined {
  const mention = /`?reasoning_effort`?[^.\n]{0,180}\b(?:accepts|supports|valid values|possible values)\b[^.\n]{0,240}/i.exec(text);
  if (!mention) return undefined;
  const efforts = [...new Set([...mention[0].matchAll(/`(none|minimal|low|medium|high|xhigh|max|ultra)`/gi)]
    .map(match => match[1]!.toLowerCase()).filter(value => EFFORTS.has(value)))];
  if (efforts.length < 2) return undefined;
  const following = text.slice(mention.index, mention.index + mention[0].length + 300);
  const defaultEffort = /defaults?\s+to\s+`?(none|minimal|low|medium|high|xhigh|max|ultra)\b/i.exec(following)?.[1]?.toLowerCase();
  return { url, sha256: createHash("sha256").update(text).digest("hex"), efforts,
    ...(defaultEffort && efforts.includes(defaultEffort) ? { defaultEffort } : {}) };
}

/** Fuente del propio autor: lectura pública acotada, sin enviar la credencial Featherless. */
export async function fetchReasoningDeclaration(modelId: string, fetchImpl: typeof fetch = fetch): Promise<ReasoningDeclaration | undefined> {
  const parts = modelId.split("/");
  if (parts.length !== 2 || parts.some(part => !part || part === "." || part === "..")) return undefined;
  const url = `https://huggingface.co/${parts.map(encodeURIComponent).join("/")}/raw/main/README.md`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const beat = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), 15_000); };
  beat();
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "text/plain" } });
    if (!response.ok || !response.body) return undefined;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      beat();
      bytes += chunk.byteLength;
      if (bytes > 1024 * 1024) { controller.abort(); return undefined; }
      chunks.push(chunk);
    }
    return reasoningDeclarationFromCard(Buffer.concat(chunks).toString("utf8"), url);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer!);
  }
}
