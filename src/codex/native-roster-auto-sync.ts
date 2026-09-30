import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadConfig } from "../config";
import { resolveTrustedWindowsSystemDirectory } from "../lib/windows-elevation";
import { providerCodexAccountMode } from "../providers/registry";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import { readCatalog, readCodexCatalogPath, type RawEntry } from "./catalog/parsing";
import { AUTHENTICATED_NATIVE_ROW_FIELD, authenticatedNativeRows } from "./catalog/live-native";
import { shouldSyncCodexOnStart } from "./desired-state";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";
import { resolveAdmittedCodexModelEntitlements } from "./model-entitlement-admission";
import { listCodexAppServerProcessesAsync } from "./app-server-processes";
import { loadPersistedCodexRuntime } from "./runtime";

/** Check once per minute; the authenticated roster itself retains its bounded five-minute TTL. */
const NATIVE_ROSTER_POLL_MS = 60_000;
const CLIENT_PROCESS_POLL_MS = 15_000;
const UPDATE_DEBOUNCE_MS = 5_000;

function capabilitySignature(row: RawEntry): string {
  // Catalog priority and visibility are local UI settings, not upstream model capabilities.
  return JSON.stringify([
    row.comp_hash, row.context_window, row.input_modalities,
    row.default_reasoning_level, row.model_messages,
  ]);
}

/** A discovered model or changed capability row needs a new static Codex catalog/cache. */
export async function nativeRosterCatalogDrift(): Promise<boolean> {
  const config = loadConfig();
  if (!shouldSyncCodexOnStart(config)) return false;
  const eligible = providerCodexAccountMode(
    OPENAI_CODEX_PROVIDER_ID, config.providers[OPENAI_CODEX_PROVIDER_ID],
  ) === "direct" ? new Set([MAIN_CODEX_ACCOUNT_ID]) : undefined;
  const snapshot = await resolveAdmittedCodexModelEntitlements(config, { clientVersion: null });
  const accounts = [...snapshot.modelsByAccount.keys()]
    .filter(id => eligible === undefined || eligible.has(id));
  if (accounts.length === 0 || !accounts.some(id => snapshot.confirmedAccountIds.has(id))) return false;
  const live = authenticatedNativeRows(snapshot, eligible);
  const catalog = readCatalog(readCodexCatalogPath());
  if (!catalog) return false;
  return hasAuthenticatedNativeCatalogDrift(
    live, catalog.models ?? [], accounts.every(id => snapshot.confirmedAccountIds.has(id)),
  );
}

/** Pure comparison shared by the live poll and focused catalog regression tests. */
export function hasAuthenticatedNativeCatalogDrift(
  live: ReadonlyMap<string, RawEntry>,
  catalogRows: readonly RawEntry[],
  fullyConfirmed: boolean,
): boolean {
  const current = new Map(catalogRows.flatMap(row =>
    typeof row.slug === "string" && !row.slug.includes("/") ? [[row.slug, row] as const] : []));
  for (const [slug, row] of live) {
    const existing = current.get(slug);
    if (!existing || existing[AUTHENTICATED_NATIVE_ROW_FIELD] !== true
      || capabilitySignature(existing) !== capabilitySignature(row)) return true;
  }
  // Only a fully confirmed roster can prove that a formerly discovered model vanished.
  if (fullyConfirmed) {
    for (const [slug, row] of current) {
      if (row[AUTHENTICATED_NATIVE_ROW_FIELD] === true && !live.has(slug)) return true;
    }
  }
  return false;
}

/** Reconcile without overlapping flights, and stop cleanly with the owning server. */
export function startNativeRosterAutoSync(): { stop(): void } {
  let stopped = false;
  let running = false;
  let eventRunning = false;
  let eventQueued = false;
  let lastFastPids: ReadonlySet<number> | null = null;
  let clientPollRunning = false;
  let updateDebounce: ReturnType<typeof setTimeout> | null = null;
  let updateWatcher: FSWatcher | null = null;

  const refreshForClientEvent = (): void => {
    if (stopped) return;
    if (eventRunning) { eventQueued = true; return; }
    eventRunning = true;
    void (async () => {
      try {
        const { refreshCatalogAfterClientEvent } = await import("./catalog-auto-refresh");
        if (!stopped) await refreshCatalogAfterClientEvent();
      } catch {
        console.warn("[opencodex] Codex client event catalog refresh deferred.");
      } finally {
        eventRunning = false;
        if (eventQueued && !stopped) { eventQueued = false; refreshForClientEvent(); }
      }
    })();
  };

  // A Codex Desktop update installs a new versioned runtime below bin/. Watch its directory
  // rather than a particular executable, whose path changes on every update.
  if (process.platform === "win32") {
    try {
      const command = loadPersistedCodexRuntime()?.command;
      if (command && basename(command).toLowerCase() === "codex.exe") {
        const parent = dirname(command);
        const root = /^[0-9a-f]{8,}$/i.test(basename(parent)) ? dirname(parent) : parent;
        updateWatcher = watch(root, { recursive: true }, () => {
          if (stopped) return;
          if (updateDebounce) clearTimeout(updateDebounce);
          updateDebounce = setTimeout(refreshForClientEvent, UPDATE_DEBOUNCE_MS);
          updateDebounce.unref?.();
        });
        updateWatcher.on("error", () => { updateWatcher?.close(); updateWatcher = null; });
      }
    } catch { /* Roster polling remains the fallback when a runtime path is unavailable. */ }
  }

  const pollClientStarts = async (): Promise<void> => {
    if (stopped || clientPollRunning) return;
    clientPollRunning = true;
    try {
      if (process.platform === "win32") {
        const pids = await fastWindowsCodexPids();
        const newlyStarted = lastFastPids === null ? [] : [...pids].filter(pid => !lastFastPids!.has(pid));
        lastFastPids = pids;
        if (newlyStarted.length === 0) return;
        const verified = await listCodexAppServerProcessesAsync();
        if (verified.some(proc => newlyStarted.includes(proc.pid))) refreshForClientEvent();
      } else {
        const verified = await listCodexAppServerProcessesAsync();
        const pids = new Set(verified.map(proc => proc.pid));
        if (lastFastPids !== null && [...pids].some(pid => !lastFastPids!.has(pid))) refreshForClientEvent();
        lastFastPids = pids;
      }
    } catch { /* A failed process observation is not an empty process list. */ }
    finally { clientPollRunning = false; }
  };
  void pollClientStarts();
  const clientTimer = setInterval(() => void pollClientStarts(), CLIENT_PROCESS_POLL_MS);
  clientTimer.unref?.();
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    void (async () => {
      try {
        if (!await nativeRosterCatalogDrift() || stopped) return;
        refreshForClientEvent();
      } catch (error) {
        // Discovery is best-effort. Log only the class; network/auth error bodies may carry data.
        console.warn(`[opencodex] Native model reconciliation deferred (${error instanceof Error ? error.name : "unknown"}).`);
      } finally {
        running = false;
      }
    })();
  }, NATIVE_ROSTER_POLL_MS);
  timer.unref?.();
  return { stop: () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(clientTimer);
    if (updateDebounce) clearTimeout(updateDebounce);
    updateWatcher?.close();
  } };
}

/** Cheap process-name gate; the slower owner/command-line verification runs only for new PIDs. */
function fastWindowsCodexPids(): Promise<ReadonlySet<number>> {
  return new Promise((resolve, reject) => {
    const tasklist = join(resolveTrustedWindowsSystemDirectory(), "tasklist.exe");
    execFile(tasklist, ["/FI", "IMAGENAME eq codex.exe", "/FO", "CSV", "/NH"], {
      windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) { reject(error); return; }
      const pids = new Set<number>();
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^"codex\.exe","(\d+)"/i.exec(line);
        if (match) pids.add(Number(match[1]));
      }
      resolve(pids);
    });
  });
}
