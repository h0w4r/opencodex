import type { CodexModelAccessPrograms, CodexModelEntitlementSnapshot } from "../model-entitlements";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";
import { isMainCodexAccountTarget } from "../account-namespaces";
import { trustedAccountBoundNativeCatalogSlug } from "./account-models";
import { NATIVE_OPENAI_MODELS } from "./native-models";
import type { RawEntry } from "./parsing";

const nativeSlugs = new Set(NATIVE_OPENAI_MODELS);

/**
 * Copy authenticated, account-scoped access programs into the final native catalog.
 * A static pinned row is useful for capabilities, but cannot prove a user's Daybreak grant.
 */
export function applyAuthenticatedNativeAccessPrograms(
  entries: RawEntry[],
  snapshot: CodexModelEntitlementSnapshot,
  bareEligibleAccountIds: ReadonlySet<string> | undefined,
  accountTargets: ReadonlyMap<string, string>,
): void {
  const rosters = snapshot.accessProgramsByAccount;
  if (!rosters) return;
  for (const entry of entries) {
    if (typeof entry.slug !== "string") continue;
    const accountSlug = trustedAccountBoundNativeCatalogSlug(entry);
    const slug = accountSlug ?? entry.slug;
    // Never project ChatGPT-account grants onto routed third-party models.
    if (!nativeSlugs.has(slug)) continue;

    let accountIds: string[];
    if (accountSlug) {
      const selector = entry.slug.slice(0, entry.slug.indexOf("/"));
      const target = accountTargets.get(selector);
      if (!target) continue;
      accountIds = [isMainCodexAccountTarget(target) ? MAIN_CODEX_ACCOUNT_ID : target];
    } else {
      accountIds = [...rosters.keys()].filter(accountId =>
        !bareEligibleAccountIds || bareEligibleAccountIds.has(accountId));
    }

    const evidenced = accountIds.flatMap(accountId => {
      if (!snapshot.confirmedAccountIds.has(accountId)) return [];
      const programs = rosters.get(accountId);
      return programs?.has(slug) ? [programs.get(slug)!] : [];
    });
    if (evidenced.length === 0) continue;

    // A bare row can route through multiple accounts. Advertise only grants common to every
    // observed account; otherwise the picker could offer a program the chosen account lacks.
    const first = evidenced[0];
    if (first === null) {
      entry.available_access_programs = null;
      continue;
    }
    const common: Record<string, string[]> = {};
    for (const [category, values] of Object.entries(first as CodexModelAccessPrograms)) {
      const shared = values.filter(value => evidenced.every(programs =>
        programs !== null && programs[category]?.includes(value)));
      if (shared.length > 0) common[category] = shared;
    }
    entry.available_access_programs = Object.keys(common).length > 0 ? common : null;
  }
}
