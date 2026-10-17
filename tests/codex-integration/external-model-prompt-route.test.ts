import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

let scratch = "";
let oldHome: string | undefined;
let codexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  oldHome = process.env.OPENCODEX_HOME;
  scratch = mkdtempSync(join(tmpdir(), "ocx-prompt-route-"));
  process.env.OPENCODEX_HOME = scratch;
  codexHome = installIsolatedCodexHome("ocx-prompt-route-codex-");
});

afterEach(() => {
  codexHome?.restore();
  codexHome = null;
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = oldHome;
  if (scratch) removeTreeWithRetry(scratch);
});

test("Codex external turn replaces its base but an unrelated Responses client does not", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push(await req.json() as Record<string, unknown>);
      return new Response([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "OK" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const path = join(scratch, "private-prompt.md");
  writeFileSync(path, "Unique external Codex base");
  const config: OcxConfig = {
    port: 0,
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`, apiKey: "test", allowPrivateNetwork: true } },
    externalModelPrompts: { codex: path },
  };
  saveConfig(config);
  const server = startServer(0);
  try {
    const body = JSON.stringify({ model: "mock/test-model", stream: true, instructions: "Original native base", input: "hello" });
    for (const originator of ["codex_cli_rs", "other-client"]) {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", originator },
        body,
      });
      expect(response.status).toBe(200);
      await response.text(); // Drain both turns before closing the test-owned listener.
    }
    expect(seen).toHaveLength(2);
    expect(JSON.stringify(seen[0])).toContain("Unique external Codex base");
    expect(JSON.stringify(seen[0])).not.toContain("Original native base");
    expect(JSON.stringify(seen[1])).toContain("Original native base");
    expect(JSON.stringify(seen[1])).not.toContain("Unique external Codex base");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
}, { timeout: SERVER_BUDGET_MS });
