import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { validateDinkuskitCanaryPublication } from "../scripts/validate-dinkuskit-canary-publication.mjs";
import { tmpPrefix } from "./helpers.ts";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const bot = "dinkuskit-clawsweeper[bot]";
const marker = "<!-- clawsweeper-review item=7 -->";
const body = `Native ClawSweeper review.\n\n${marker}`;
const bodyHash = createHash("sha256").update(body.trim()).digest("hex");

function fixture(options: { action?: string; reason?: string; commentBody?: string } = {}) {
  const root = mkdtempSync(tmpPrefix);
  const reportPath = join(root, "7.md");
  const applyReportPath = join(root, "apply-report.json");
  const commentsPath = join(root, "comments.json");
  const labelsPath = join(root, "labels.json");
  const commentBody = options.commentBody ?? body;
  const labels = ["documentation", "rating: 🦐 gold shrimp"];
  mkdirSync(root, { recursive: true });
  writeFileSync(
    reportPath,
    `---
number: 7
repository: dinkuskit/blocks
type: pull_request
review_status: complete
local_checkout_access: verified
main_sha: ${baseSha}
pull_head_sha: ${headSha}
labels: ${JSON.stringify(labels)}
review_comment_id: 123
review_comment_url: https://github.com/dinkuskit/blocks/issues/7#issuecomment-123
review_comment_sha256: ${bodyHash}
---

## Summary

Native ClawSweeper report.
`,
  );
  const applyReport = options.action
    ? [{ number: 7, action: options.action, reason: options.reason ?? "updated review" }]
    : [];
  writeFileSync(applyReportPath, `${JSON.stringify(applyReport)}\n`);
  writeFileSync(
    commentsPath,
    `${JSON.stringify([
      {
        id: 123,
        html_url: "https://github.com/dinkuskit/blocks/issues/7#issuecomment-123",
        body: commentBody,
        user: { login: bot },
      },
    ])}\n`,
  );
  writeFileSync(labelsPath, `${JSON.stringify(labels)}\n`);
  return { root, reportPath, applyReportPath, commentsPath, labelsPath };
}

function validate(files: ReturnType<typeof fixture>) {
  return validateDinkuskitCanaryPublication({
    ...files,
    appBotLogin: bot,
    repository: "dinkuskit/blocks",
    itemNumber: 7,
    baseSha,
    headSha,
  });
}

test("publication validator accepts an exact idempotent native publication", () => {
  const files = fixture();
  try {
    const result = validate(files);
    assert.equal(result.comment_id, 123);
    assert.equal(result.label_count, 2);
  } finally {
    rmSync(files.root, { recursive: true, force: true });
  }
});

test("publication validator accepts the native comment-sync result", () => {
  const files = fixture({ action: "review_comment_synced" });
  try {
    assert.equal(validate(files).comment_sha256, bodyHash);
  } finally {
    rmSync(files.root, { recursive: true, force: true });
  }
});

test("publication validator rejects a swallowed native apply failure", () => {
  const files = fixture({ action: "skipped_comment_auth" });
  try {
    assert.throws(() => validate(files), /did not prove native publication/);
  } finally {
    rmSync(files.root, { recursive: true, force: true });
  }
});

test("publication validator rejects a stale or mismatched comment body", () => {
  const files = fixture({ commentBody: `${body}\nchanged` });
  try {
    assert.throws(() => validate(files), /state record hash/);
  } finally {
    rmSync(files.root, { recursive: true, force: true });
  }
});
