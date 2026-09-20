import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";

export const FEATHERLESS_CAPABILITY_EVIDENCE_SCHEMA = 1;
export const FEATHERLESS_CAPABILITY_EVIDENCE_FILE = "capability-evidence.json";
export const FEATHERLESS_OFFICIAL_BASE_URL = "https://api.featherless.ai/v1";

export interface FeatherlessCapabilityProof {
  modelId: string;
  capability: "tool-calling";
  status: "verified";
  transport: "openai-chat-stream";
  observedAt: string;
  expiresAt: string;
  probeVersion: string;
  resultSha256: string;
}

interface FeatherlessCapabilityFile {
  schemaVersion: number;
  providerBaseUrl: string;
  generatedAt: string;
  proofs: unknown[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Valida evidencia producida por un recorrido real. El archivo es una caché de
 * capacidades locales: nunca contiene API keys, prompts ni respuestas del modelo.
 */
export function parseFeatherlessCapabilityEvidence(
  value: unknown,
  now = Date.now(),
): Map<string, FeatherlessCapabilityProof> {
  const file = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<FeatherlessCapabilityFile>
    : {};
  const generated = Date.parse(String(file.generatedAt ?? ""));
  if (file.schemaVersion !== FEATHERLESS_CAPABILITY_EVIDENCE_SCHEMA
    || file.providerBaseUrl !== FEATHERLESS_OFFICIAL_BASE_URL
    || !ISO_DATE.test(String(file.generatedAt ?? ""))
    || !Number.isFinite(generated)
    || !Array.isArray(file.proofs)
    || file.proofs.length > 10_000) return new Map();

  const proofs = new Map<string, FeatherlessCapabilityProof>();
  for (const candidate of file.proofs) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const proof = candidate as Partial<FeatherlessCapabilityProof>;
    const observed = Date.parse(String(proof.observedAt ?? ""));
    const expires = Date.parse(String(proof.expiresAt ?? ""));
    if (typeof proof.modelId !== "string" || !proof.modelId.includes("/")
      || proof.modelId.length > 1024 || /[\u0000-\u001f]/.test(proof.modelId)
      || proof.capability !== "tool-calling" || proof.status !== "verified"
      || proof.transport !== "openai-chat-stream"
      || typeof proof.probeVersion !== "string" || !proof.probeVersion || proof.probeVersion.length > 100
      || !SHA256.test(String(proof.resultSha256 ?? ""))
      || !Number.isFinite(observed) || !Number.isFinite(expires)
      || observed > now + 5 * 60_000 || observed > generated + 5 * 60_000
      || expires <= now || expires <= observed || expires - observed > 45 * 86400000) continue;
    const normalized = proof as FeatherlessCapabilityProof;
    const previous = proofs.get(normalized.modelId);
    // Si hay duplicados, conserva únicamente la observación válida más reciente.
    if (!previous || Date.parse(previous.observedAt) < observed) proofs.set(normalized.modelId, normalized);
  }
  return proofs;
}

/** Lee la evidencia vigente sin convertir un archivo ausente o dañado en admisión. */
export function loadFeatherlessCapabilityEvidence(now = Date.now()): Map<string, FeatherlessCapabilityProof> {
  const path = join(getConfigDir(), "featherless-catalog", FEATHERLESS_CAPABILITY_EVIDENCE_FILE);
  if (!existsSync(path)) return new Map();
  try {
    return parseFeatherlessCapabilityEvidence(JSON.parse(readFileSync(path, "utf8")), now);
  } catch {
    return new Map();
  }
}

/** Un cambio efectivo de pruebas invalida el snapshot; regenerar el mismo archivo no. */
export function fingerprintFeatherlessCapabilityEvidence(proofs: Map<string, FeatherlessCapabilityProof>): string {
  const stable = [...proofs.values()].sort((a, b) => a.modelId.localeCompare(b.modelId))
    .map(proof => [proof.modelId, proof.observedAt, proof.expiresAt, proof.transport, proof.resultSha256]);
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 24);
}
