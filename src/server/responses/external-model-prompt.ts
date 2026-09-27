/** Model-scoped prompt replacement for genuine Codex and Claude Code clients. */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { RouteResult } from "../../router";
import type { OcxConfig, OcxParsedRequest } from "../../types";

const CODEX_ORIGINATORS = new Set([
  "codex_cli_rs", "Codex Desktop", "codex_app", "codex_work_desktop", "codexless_agent",
]);
const MAX_PROMPT_BYTES = 128 * 1024;

/** Never log the prompt body or include it in a public catalog or configuration. */
export function readExternalModelPrompt(path: string): string {
  if (!isAbsolute(path)) throw new Error("external model prompt path must be absolute");
  // Do not echo a private filesystem path in an HTTP error returned to a client.
  let stat: ReturnType<typeof statSync>;
  try { stat = statSync(path); }
  catch { throw new Error("external model prompt file is not readable"); }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_PROMPT_BYTES) {
    throw new Error("external model prompt must be a nonempty file of at most 128 KiB");
  }
  // A 128 KiB maximum makes reading every turn cheap and avoids stale same-size edits.
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch { throw new Error("external model prompt file is not readable"); }
  if (!text.trim()) throw new Error("external model prompt is empty");
  return text;
}

/** Classify by the resolved provider, not a user-facing alias or model-name prefix alone. */
export function externalPromptPathForRoute(
  config: OcxConfig,
  route: RouteResult,
  inboundWire: "responses" | "anthropic" | "chat",
  headers: Headers,
): string | undefined {
  if (inboundWire === "anthropic") {
    // Genuine native Claude requests usually bypass this pipeline entirely; this also
    // protects translated Anthropic-owned requests when native passthrough is unavailable.
    return route.providerName === "anthropic" ? undefined : config.externalModelPrompts?.claudeCode;
  }
  if (inboundWire !== "responses" || !CODEX_ORIGINATORS.has(headers.get("originator") ?? "")) {
    return undefined;
  }
  return route.providerName === "openai" ? undefined : config.externalModelPrompts?.codex;
}

/** Replace only the base instructions; keep distinct chronological developer/user messages. */
export function replaceExternalBasePrompt(parsed: OcxParsedRequest, text: string, isClaude: boolean): void {
  const raw = parsed._rawBody;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const body = raw as Record<string, unknown>;
  const previous = typeof body.instructions === "string" && body.instructions.length > 0;
  body.instructions = text;
  const system = parsed.context.systemPrompt ?? [];
  if (previous && system.length > 0) system[0] = text;
  else system.unshift(text);
  parsed.context.systemPrompt = system;
  // Claude's translated cache affinity was computed from the old base. Salt it with
  // this prompt's fingerprint so edits cannot reuse an incompatible prefix cohort.
  if (isClaude && typeof parsed.options.promptCacheKey === "string") {
    const key = createHash("sha256")
      .update(parsed.options.promptCacheKey).update("\0").update(text).digest("hex").slice(0, 32);
    parsed.options.promptCacheKey = key;
    body.prompt_cache_key = key;
  }
}
