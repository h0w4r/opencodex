import type { CodexModelEntitlementSnapshot } from "../model-entitlements";
import type { RawEntry } from "./parsing";
import { RETIRED_NATIVE_OPENAI_MODELS } from "./native-models";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "./kinds";
import { COMBO_NAMESPACE } from "../../combos";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";

/** Provenance survives a catalog/cache write without pretending that a guessed GPT id is native. */
export const AUTHENTICATED_NATIVE_ROW_FIELD = "opencodex_authenticated_native_roster";

function validNativeRow(slug: string, row: Readonly<Record<string, unknown>>): row is RawEntry {
  if (!/^(?:gpt|codex)-[a-z0-9][a-z0-9._-]*$/.test(slug)
    || RETIRED_NATIVE_OPENAI_MODELS.has(slug)
    || row.slug !== slug
    || row.supported_in_api !== true
    || row.visibility !== "list"
    || typeof row.display_name !== "string"
    || !Number.isSafeInteger(row.context_window)
    || Number(row.context_window) <= 0
    || !Array.isArray(row.input_modalities)
    || !Array.isArray(row.supported_reasoning_levels)) return false;
  return row.input_modalities.every(mode => typeof mode === "string")
    && row.supported_reasoning_levels.every(level => level && typeof level === "object"
      && typeof (level as { effort?: unknown }).effort === "string");
}

/** Main-account rows take precedence; Pool rows supply models unavailable to the main account. */
export function authenticatedNativeRows(
  snapshot: CodexModelEntitlementSnapshot,
  eligibleAccountIds?: ReadonlySet<string>,
): ReadonlyMap<string, RawEntry> {
  const rows = new Map<string, RawEntry>();
  const accounts = [...(snapshot.modelRowsByAccount?.keys() ?? [])]
    .filter(id => eligibleAccountIds === undefined || eligibleAccountIds.has(id))
    .sort((a, b) => Number(b === MAIN_CODEX_ACCOUNT_ID) - Number(a === MAIN_CODEX_ACCOUNT_ID));
  for (const accountId of accounts) {
    for (const [slug, raw] of snapshot.modelRowsByAccount?.get(accountId) ?? []) {
      if (rows.has(slug) || !validNativeRow(slug, raw)) continue;
      rows.set(slug, { ...structuredClone(raw), [AUTHENTICATED_NATIVE_ROW_FIELD]: true } as RawEntry);
    }
  }
  return rows;
}

/** Preserve the last verified row during a roster outage; remove it only on confirmed withdrawal. */
export function mergeAuthenticatedNativeRows(
  existing: readonly RawEntry[],
  snapshot: CodexModelEntitlementSnapshot,
  eligibleAccountIds?: ReadonlySet<string>,
): { rows: RawEntry[]; slugs: string[] } {
  const live = authenticatedNativeRows(snapshot, eligibleAccountIds);
  const accounts = [...snapshot.modelsByAccount.keys()]
    .filter(id => eligibleAccountIds === undefined || eligibleAccountIds.has(id));
  const fullyConfirmed = accounts.length > 0 && accounts.every(id => snapshot.confirmedAccountIds.has(id));
  const retained = existing.filter(row => {
    const slug = typeof row.slug === "string" ? row.slug : "";
    if (row[AUTHENTICATED_NATIVE_ROW_FIELD] !== true || slug.includes("/")) return true;
    return !fullyConfirmed || live.has(slug);
  });
  const bySlug = new Map(retained.flatMap((row, index) =>
    typeof row.slug === "string" && !row.slug.includes("/") ? [[row.slug, index] as const] : []));
  for (const [slug, row] of live) {
    const index = bySlug.get(slug);
    if (index === undefined) {
      bySlug.set(slug, retained.length);
      retained.push(row);
    } else {
      // An explicit native-alias combo owns its bare id; live discovery must not replace it.
      const prior = retained[index]!;
      if (prior.opencodex_catalog_kind !== CODEX_NATIVE_ALIAS_CATALOG_KIND && prior.owned_by !== COMBO_NAMESPACE) {
        retained[index] = row;
      }
    }
  }
  return {
    rows: retained,
    slugs: retained.flatMap(row => row[AUTHENTICATED_NATIVE_ROW_FIELD] === true
      && typeof row.slug === "string" && !row.slug.includes("/") ? [row.slug] : []),
  };
}
