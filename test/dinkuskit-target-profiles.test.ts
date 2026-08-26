import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { resolveTargetRepoToolchain } from "../dist/repair/target-toolchain-config.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";

type TargetProfile = {
  target_repo?: string;
  checkout_dir?: string;
  apply_close_rules?: { issue?: string[]; pull_request?: string[] };
  validation_commands?: string[];
  changed_gate?: unknown;
};

const config = JSON.parse(
  readFileSync(new URL("../config/target-repositories.json", import.meta.url), "utf8"),
) as { repositories?: TargetProfile[] };

const expected = [
  { repo: "blocks", packageManager: "pnpm" },
  { repo: "template-store", packageManager: "pnpm" },
  { repo: "template-services", packageManager: "pnpm" },
  { repo: "template-marketing", packageManager: "pnpm" },
  { repo: "inventory", packageManager: "pnpm" },
  { repo: "coupons", packageManager: "pnpm" },
  { repo: "bundles", packageManager: "pnpm" },
  { repo: "commerce", packageManager: "npm" },
] as const;

test("DinkusKit targets are explicit, collision-safe, and review-only", () => {
  const profiles = config.repositories ?? [];
  for (const { repo, packageManager } of expected) {
    const target = `dinkuskit/${repo}`;
    const profile = repositoryProfileFor(target);
    const matches = profiles.filter(
      (profile) => profile.target_repo?.toLowerCase() === target.toLowerCase(),
    );
    assert.equal(profile.targetRepo, target);
    assert.equal(matches.length, 1, `${target} must have one explicit profile`);
    assert.equal(matches[0]?.checkout_dir, `dinkuskit-${repo}`);
    assert.deepEqual(matches[0]?.apply_close_rules, { issue: [], pull_request: [] });
    assert.deepEqual(matches[0]?.validation_commands, []);
    assert.equal(matches[0]?.changed_gate, null);
    assert.equal(profile.checkoutDir, `dinkuskit-${repo}`);
    assert.equal(resolveTargetRepoToolchain(target).packageManager, packageManager);
  }

  const dinkusCheckoutDirs = expected.map(({ repo }) => `dinkuskit-${repo}`);
  assert.equal(new Set(dinkusCheckoutDirs).size, dinkusCheckoutDirs.length);
  const otherCheckoutDirs = profiles
    .filter((profile) => !profile.target_repo?.startsWith("dinkuskit/"))
    .map((profile) => profile.checkout_dir);
  for (const checkoutDir of dinkusCheckoutDirs) {
    assert.ok(!otherCheckoutDirs.includes(checkoutDir), `${checkoutDir} must be owner-qualified`);
  }
});
