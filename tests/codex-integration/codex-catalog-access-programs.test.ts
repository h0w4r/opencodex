import { describe, expect, test } from "bun:test";
import { applyAuthenticatedNativeAccessPrograms } from "../../src/codex/catalog/access-programs";
import type { CodexModelEntitlementSnapshot } from "../../src/codex/model-entitlements";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";

function snapshot(programs: ReadonlyMap<string, ReadonlyMap<string, Readonly<Record<string, readonly string[]>> | null>>): CodexModelEntitlementSnapshot {
  return {
    modelsByAccount: new Map(),
    clientVersionByAccount: new Map(),
    confirmedAccountIds: new Set(programs.keys()),
    credentialIdentities: new Map(),
    accessProgramsByAccount: programs,
  };
}

describe("authenticated native access-program projection", () => {
  test("restores Daybreak eligibility to supported GPT models without touching routed models", () => {
    const models = [
      { slug: "gpt-5.6-sol", available_access_programs: null },
      { slug: "gpt-6-luna", available_access_programs: { cyber: ["standard"] } },
      { slug: "gpt-daybreak-blue-latest", available_access_programs: null },
      { slug: "gpt-6-astra", available_access_programs: null },
      { slug: "featherless/gpt-5.6-sol", available_access_programs: null },
    ];
    const roster = new Map<string, Readonly<Record<string, readonly string[]>> | null>([
      ["gpt-5.6-sol", { cyber: ["standard", "daybreak_blue"] }],
      ["gpt-6-luna", { cyber: ["standard", "daybreak_blue"] }],
      ["gpt-daybreak-blue-latest", { cyber: ["daybreak_blue"] }],
      ["gpt-6-astra", { cyber: ["standard"] }],
    ]);
    applyAuthenticatedNativeAccessPrograms(models, snapshot(new Map([[MAIN_CODEX_ACCOUNT_ID, roster]])),
      new Set([MAIN_CODEX_ACCOUNT_ID]), new Map());
    expect(models[0].available_access_programs).toEqual({ cyber: ["standard", "daybreak_blue"] });
    expect(models[1].available_access_programs).toEqual({ cyber: ["standard", "daybreak_blue"] });
    expect(models[2].available_access_programs).toEqual({ cyber: ["daybreak_blue"] });
    expect(models[3].available_access_programs).toEqual({ cyber: ["standard"] });
    expect(models[4].available_access_programs).toBeNull();
  });

  test("uses the exact account for qualified rows and intersects bare multi-account grants", () => {
    const models = [
      { slug: "gpt-5.6-sol", available_access_programs: null },
      { slug: "main/gpt-5.6-sol", opencodex_catalog_kind: "account-selector-v1", available_access_programs: null },
      { slug: "side/gpt-5.6-sol", opencodex_catalog_kind: "account-selector-v1", available_access_programs: null },
    ];
    const rosters = new Map([
      [MAIN_CODEX_ACCOUNT_ID, new Map([["gpt-5.6-sol", { cyber: ["standard", "daybreak_blue"] }]])],
      ["pool-side", new Map([["gpt-5.6-sol", { cyber: ["standard"] }]])],
    ]);
    applyAuthenticatedNativeAccessPrograms(models, snapshot(rosters), undefined,
      new Map([["main", "@main"], ["side", "pool-side"]]));
    expect(models[0].available_access_programs).toEqual({ cyber: ["standard"] });
    expect(models[1].available_access_programs).toEqual({ cyber: ["standard", "daybreak_blue"] });
    expect(models[2].available_access_programs).toEqual({ cyber: ["standard"] });
  });
});
