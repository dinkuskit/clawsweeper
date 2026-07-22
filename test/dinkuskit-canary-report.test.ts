import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { validateDinkuskitCanaryReport } from "../scripts/validate-dinkuskit-canary-report.mjs";
import { tmpPrefix } from "./helpers.ts";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function report(overrides: Record<string, string> = {}): string {
  const fields = {
    number: "7",
    repository: "dinkuskit/blocks",
    type: "pull_request",
    review_status: "complete",
    local_checkout_access: "verified",
    main_sha: baseSha,
    pull_head_sha: headSha,
    ...overrides,
  };
  return `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n\n## Summary\n\nNative ClawSweeper report.\n`;
}

test("canary report validator binds the native report to the exact PR tuple", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const path = join(root, "7.md");
    writeFileSync(path, report());
    const result = validateDinkuskitCanaryReport({
      reportPath: path,
      repository: "dinkuskit/blocks",
      itemNumber: 7,
      baseSha,
      headSha,
    });
    assert.equal(result.repository, "dinkuskit/blocks");
    assert.equal(result.item_number, 7);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

for (const [name, override, message] of [
  ["head drift", { pull_head_sha: "c".repeat(40) }, /pull_head_sha/],
  ["base drift", { main_sha: "c".repeat(40) }, /main_sha/],
  ["failed review", { review_status: "failed" }, /review_status/],
  ["unverified checkout", { local_checkout_access: "unknown" }, /local_checkout_access/],
] as const) {
  test(`canary report validator rejects ${name}`, () => {
    const root = mkdtempSync(tmpPrefix);
    try {
      const path = join(root, "7.md");
      writeFileSync(path, report(override));
      assert.throws(
        () =>
          validateDinkuskitCanaryReport({
            reportPath: path,
            repository: "dinkuskit/blocks",
            itemNumber: 7,
            baseSha,
            headSha,
          }),
        message,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
}
