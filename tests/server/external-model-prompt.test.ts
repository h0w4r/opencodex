import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequest } from "../../src/responses/parser";
import {
  externalPromptPathForRoute,
  readExternalModelPrompt,
  replaceExternalBasePrompt,
} from "../../src/server/responses/external-model-prompt";
import type { RouteResult } from "../../src/router";
import type { OcxConfig } from "../../src/types";

const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
  externalModelPrompts: { codex: "C:/private/codex.md", claudeCode: "C:/private/claude.md" },
} as OcxConfig;
const route = (providerName: string) => ({ providerName }) as RouteResult;
const codex = new Headers({ originator: "codex_cli_rs" });
let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe("external model prompt routing", () => {
  test("keeps native and unrelated clients untouched", () => {
    expect(externalPromptPathForRoute(config, route("openai"), "responses", codex)).toBeUndefined();
    expect(externalPromptPathForRoute(config, route("featherless"), "responses", new Headers())).toBeUndefined();
    expect(externalPromptPathForRoute(config, route("anthropic"), "anthropic", new Headers())).toBeUndefined();
    expect(externalPromptPathForRoute(config, route("featherless"), "chat", codex)).toBeUndefined();
  });

  test("selects only the respective external Codex or Claude prompt", () => {
    expect(externalPromptPathForRoute(config, route("featherless"), "responses", codex))
      .toBe(config.externalModelPrompts!.codex);
    expect(externalPromptPathForRoute(config, route("featherless"), "anthropic", new Headers()))
      .toBe(config.externalModelPrompts!.claudeCode);
  });

  test("replaces the base without deleting chronological developer messages", () => {
    const raw = {
      model: "featherless/model",
      instructions: "Native harness base",
      input: [
        { role: "developer", content: "Keep this instruction" },
        { role: "user", content: "hello" },
      ],
      prompt_cache_key: "original-key",
    };
    const parsed = parseRequest(raw);
    replaceExternalBasePrompt(parsed, "External model base", true);
    expect(parsed.context.systemPrompt?.[0]).toBe("External model base");
    expect((parsed._rawBody as typeof raw).instructions).toBe("External model base");
    expect(parsed.context.messages.some(message => message.role === "developer")).toBe(true);
    expect(parsed.options.promptCacheKey).not.toBe("original-key");
    expect(parsed.options.promptCacheKey).toBe((parsed._rawBody as typeof raw).prompt_cache_key);
  });

  test("reads a private file and refreshes it after an edit", () => {
    scratch = mkdtempSync(join(tmpdir(), "ocx-external-prompt-"));
    const path = join(scratch, "external.md");
    writeFileSync(path, "First prompt");
    expect(readExternalModelPrompt(path)).toBe("First prompt");
    writeFileSync(path, "Second prompt with a different size");
    expect(readExternalModelPrompt(path)).toBe("Second prompt with a different size");
  });

  test("rejects missing or empty prompt instead of silently falling back", () => {
    scratch = mkdtempSync(join(tmpdir(), "ocx-external-prompt-"));
    const missing = join(scratch, "absent.md");
    expect(() => readExternalModelPrompt(missing)).toThrow("external model prompt file is not readable");
    try { readExternalModelPrompt(missing); }
    catch (error) { expect(String(error)).not.toContain(missing); }
    const empty = join(scratch, "empty.md");
    writeFileSync(empty, "");
    expect(() => readExternalModelPrompt(empty)).toThrow();
  });
});
