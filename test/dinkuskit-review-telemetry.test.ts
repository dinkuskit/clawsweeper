import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ADMITTED_REPOSITORIES,
  CLAWSWEEPER_RANKS,
  DINKUSKIT_LANE,
  MAX_BODY_BYTES,
  MAX_ROWS,
  SOURCE,
  TELEMETRY_RELATIVE_PATH,
  TENANT,
  buildDinkuskitReviewTelemetry,
  mapClawsweeperRank,
  writeDinkuskitReviewTelemetry,
} from "../scripts/publish-dinkuskit-review-telemetry.mjs";

const NOW = Date.parse("2026-09-17T18:00:00Z");
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const ENGINE = "c".repeat(40);
const OTHER_HEAD = "d".repeat(40);
const SCRIPT = fileURLToPath(
  new URL("../scripts/publish-dinkuskit-review-telemetry.mjs", import.meta.url),
);
const GENERATED_AT = "2026-09-17T18:00:00.000Z";

function fixtureRoot() {
  return mkdtempSync(join(tmpdir(), "dinkuskit-review-telemetry-"));
}

function reportMarkdown(
  options: {
    verdict?: string | null;
    rating?: string;
    reviewedAt?: string;
    commentUrl?: string;
    extraFrontmatter?: string;
  } = {},
) {
  const verdict =
    options.verdict === null
      ? ""
      : `<!-- clawsweeper-verdict:${options.verdict ?? "pass"} item=7 sha=${HEAD} confidence=high -->`;
  return `---
number: 7
repository: dinkuskit/blocks
type: pull_request
url: https://github.com/dinkuskit/blocks/pull/7
review_status: complete
local_checkout_access: verified
main_sha: ${BASE}
pull_head_sha: ${HEAD}
pr_rating_overall: ${options.rating ?? "C"}
reviewed_at: ${options.reviewedAt ?? "2026-09-17T17:55:00Z"}
review_comment_id: 123
review_comment_url: ${options.commentUrl ?? "https://github.com/dinkuskit/blocks/issues/7#issuecomment-123"}
review_comment_sha256: ${"e".repeat(64)}
${options.extraFrontmatter ?? ""}---

# #7: sample

${verdict}

## Summary

Native ClawSweeper report.
`;
}

function writeInputs(
  root: string,
  options: {
    verdict?: string | null;
    rating?: string;
    labels?: string[];
    commentUrl?: string;
    reviewedAt?: string;
  } = {},
) {
  const reportPath = join(root, "7.md");
  const labelsPath = join(root, "labels.json");
  const commentsPath = join(root, "comments.json");
  const commentUrl =
    options.commentUrl ?? "https://github.com/dinkuskit/blocks/issues/7#issuecomment-123";
  writeFileSync(
    reportPath,
    reportMarkdown({
      verdict: options.verdict,
      rating: options.rating,
      commentUrl,
      reviewedAt: options.reviewedAt,
    }),
  );
  writeFileSync(
    labelsPath,
    `${JSON.stringify(options.labels ?? ["documentation", "rating: 🦐 gold shrimp"])}\n`,
  );
  writeFileSync(
    commentsPath,
    `${JSON.stringify([
      {
        id: 123,
        html_url: commentUrl,
        body: "Native ClawSweeper review.\n\n<!-- clawsweeper-review item=7 -->",
        user: { login: "dinkuskit-clawsweeper[bot]" },
      },
    ])}\n`,
  );
  return { reportPath, labelsPath, commentsPath };
}

function publish(root: string, overrides: Record<string, unknown> = {}) {
  const files = writeInputs(root);
  return buildDinkuskitReviewTelemetry({
    reportPath: files.reportPath,
    labelsPath: files.labelsPath,
    commentsPath: files.commentsPath,
    repository: "dinkuskit/blocks",
    repositoryId: 1306882611,
    itemNumber: 7,
    baseSha: BASE,
    headSha: HEAD,
    engineSha: ENGINE,
    generatedAt: GENERATED_AT,
    workflowRunUrl: "https://github.com/dinkuskit/blocks/actions/runs/99",
    now: NOW,
    ...overrides,
  });
}

function existingRow(overrides: Record<string, unknown> = {}) {
  return {
    repository: "dinkuskit/inventory",
    pr_number: 3,
    base_sha: BASE,
    head_sha: OTHER_HEAD,
    ci: "unknown",
    ci_conclusion: null,
    openclaw: "unknown",
    openclaw_conclusion: null,
    clawsweeper: "completed",
    clawsweeper_conclusion: "success",
    rating: "B Platinum Hermit",
    proof_links: ["https://github.com/dinkuskit/inventory/pull/3"],
    engine_sha: ENGINE,
    executor: "dinkuskit-native-canary",
    findings_total: null,
    findings_actionable: null,
    observed_at: "2026-09-17T16:00:00.000Z",
    source: SOURCE,
    ...overrides,
  };
}

function existingEnvelope(rows = [existingRow()], overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "clawsweeper.telemetry.v1",
    tenant: TENANT,
    generated_at: "2026-09-17T16:00:00.000Z",
    stale_after_seconds: 900,
    lane: { ...DINKUSKIT_LANE },
    rows,
    ...overrides,
  };
}

function consumerAccepts(envelope: Record<string, unknown>) {
  assert.equal(envelope.schema_version, "clawsweeper.telemetry.v1");
  assert.equal(envelope.tenant, "dinkuskit");
  assert.equal(typeof envelope.generated_at, "string");
  assert.ok(Number.isFinite(Date.parse(String(envelope.generated_at))));
  assert.deepEqual(envelope.lane, DINKUSKIT_LANE);
  assert.ok(Array.isArray(envelope.rows));
  assert.ok((envelope.rows as unknown[]).length <= 500);
  for (const value of envelope.rows as Array<Record<string, unknown>>) {
    assert.match(String(value.repository), /^dinkuskit\/[A-Za-z0-9_.-]+$/);
    assert.ok(Number.isInteger(value.pr_number) && Number(value.pr_number) >= 1);
    assert.equal(typeof value.source, "string");
    assert.ok(String(value.source).length > 0);
  }
}

test("publishes the official rank ladder and admitted DinkusKit repositories", () => {
  assert.deepEqual(CLAWSWEEPER_RANKS, [
    "S Challenger Crab",
    "A Diamond Lobster",
    "B Platinum Hermit",
    "C Gold Shrimp",
    "D Silver Shellfish",
    "F Unranked Krab",
    "N/A Off-meta Tidepool",
  ]);
  assert.equal(mapClawsweeperRank("rating: 🦐 gold shrimp"), "C Gold Shrimp");
  assert.equal(ADMITTED_REPOSITORIES["dinkuskit/blocks"], 1306882611);
  assert.equal(ADMITTED_REPOSITORIES["dinkuskit/commerce"], 1347692514);
});

test("complete native publication produces a consumer-valid current row without inventing CI or OpenClaw", () => {
  const root = fixtureRoot();
  try {
    const envelope = publish(root);
    consumerAccepts(envelope);
    assert.equal(envelope.generated_at, GENERATED_AT);
    assert.equal(envelope.stale_after_seconds, 900);
    assert.equal(envelope.rows.length, 1);
    assert.deepEqual(envelope.rows[0], {
      repository: "dinkuskit/blocks",
      pr_number: 7,
      base_sha: BASE,
      head_sha: HEAD,
      ci: "unknown",
      ci_conclusion: null,
      openclaw: "unknown",
      openclaw_conclusion: null,
      clawsweeper: "completed",
      clawsweeper_conclusion: "success",
      rating: "C Gold Shrimp",
      proof_links: [
        "https://github.com/dinkuskit/blocks/pull/7",
        "https://github.com/dinkuskit/blocks/issues/7#issuecomment-123",
        "https://github.com/dinkuskit/blocks/actions/runs/99",
      ],
      engine_sha: ENGINE,
      executor: "dinkuskit-native-canary",
      findings_total: null,
      findings_actionable: null,
      observed_at: "2026-09-17T17:55:00.000Z",
      source: SOURCE,
    });
    assert.notEqual(envelope.rows[0]?.ci, "success");
    assert.notEqual(envelope.rows[0]?.openclaw, "success");
    assert.notEqual(envelope.rows[0]?.findings_total, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing verdict and rating stay unknown or null instead of success or zero", () => {
  const root = fixtureRoot();
  try {
    writeInputs(root, { verdict: null, rating: "", labels: ["documentation"] });
    const files = {
      reportPath: join(root, "7.md"),
      labelsPath: join(root, "labels.json"),
      commentsPath: join(root, "comments.json"),
    };
    writeFileSync(
      files.reportPath,
      reportMarkdown({ verdict: null, rating: "" }).replace("pr_rating_overall: \n", ""),
    );
    const envelope = buildDinkuskitReviewTelemetry({
      ...files,
      repository: "dinkuskit/blocks",
      repositoryId: 1306882611,
      itemNumber: 7,
      baseSha: BASE,
      headSha: HEAD,
      engineSha: ENGINE,
      generatedAt: GENERATED_AT,
      now: NOW,
    });
    assert.equal(envelope.rows[0]?.clawsweeper, "completed");
    assert.equal(envelope.rows[0]?.clawsweeper_conclusion, null);
    assert.equal(envelope.rows[0]?.rating, null);
    assert.equal(envelope.rows[0]?.findings_actionable, null);
    assert.notEqual(envelope.rows[0]?.clawsweeper_conclusion, "success");
    assert.notEqual(envelope.rows[0]?.clawsweeper_conclusion, "failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("needs-changes is published as a completed ClawSweeper failure", () => {
  const root = fixtureRoot();
  try {
    const envelope = publish(root, {
      existingEnvelope: null,
    });
    writeInputs(root, {
      verdict: "needs-changes",
      rating: "F",
      labels: ["rating: 🧂 unranked krab"],
    });
    const failed = buildDinkuskitReviewTelemetry({
      reportPath: join(root, "7.md"),
      labelsPath: join(root, "labels.json"),
      commentsPath: join(root, "comments.json"),
      repository: "dinkuskit/blocks",
      repositoryId: 1306882611,
      itemNumber: 7,
      baseSha: BASE,
      headSha: HEAD,
      engineSha: ENGINE,
      generatedAt: GENERATED_AT,
      now: NOW,
    });
    assert.equal(failed.rows[0]?.clawsweeper_conclusion, "failure");
    assert.equal(failed.rows[0]?.rating, "F Unranked Krab");
    assert.equal(envelope.rows[0]?.clawsweeper_conclusion, "success");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upserts the admitted PR and keeps other validated DinkusKit rows", () => {
  const root = fixtureRoot();
  try {
    const prior = existingRow({
      repository: "dinkuskit/blocks",
      pr_number: 7,
      head_sha: OTHER_HEAD,
      clawsweeper_conclusion: "failure",
    });
    const envelope = publish(root, {
      existingEnvelope: existingEnvelope([prior, existingRow()]),
    });
    assert.equal(envelope.rows.length, 2);
    assert.equal(envelope.rows[0]?.repository, "dinkuskit/blocks");
    assert.equal(envelope.rows[0]?.head_sha, HEAD);
    assert.equal(envelope.rows[0]?.clawsweeper_conclusion, "success");
    assert.equal(envelope.rows[1]?.repository, "dinkuskit/inventory");
    assert.equal(envelope.rows[1]?.pr_number, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains an old valid existing row and refreshes the envelope publication clock", () => {
  const root = fixtureRoot();
  try {
    const priorObservedAt = "2026-09-17T16:00:00.000Z";
    const priorEnvelope = existingEnvelope([existingRow({ observed_at: priorObservedAt })], {
      generated_at: priorObservedAt,
    });
    assert.ok(
      NOW - Date.parse(String(priorEnvelope.generated_at)) >
        Number(priorEnvelope.stale_after_seconds) * 1000,
      "fixture must exceed stale_after_seconds so idle publication is the case under test",
    );
    const envelope = publish(root, { existingEnvelope: priorEnvelope });
    consumerAccepts(envelope);
    assert.equal(envelope.generated_at, GENERATED_AT);
    assert.notEqual(envelope.generated_at, priorEnvelope.generated_at);
    assert.equal(envelope.rows.length, 2);
    const historical = envelope.rows.find((row) => row.pr_number === 3);
    assert.equal(historical?.repository, "dinkuskit/inventory");
    assert.equal(historical?.observed_at, priorObservedAt);
    assert.ok(
      NOW - Date.parse(String(historical?.observed_at)) > envelope.stale_after_seconds * 1000,
    );
    const current = envelope.rows.find((row) => row.pr_number === 7);
    assert.equal(current?.observed_at, "2026-09-17T17:55:00.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writes only the exact DinkusKit telemetry path under the state root", () => {
  const root = fixtureRoot();
  const stateRoot = join(root, "state");
  mkdirSync(stateRoot, { recursive: true });
  try {
    const files = writeInputs(root);
    const result = writeDinkuskitReviewTelemetry({
      stateRoot,
      reportPath: files.reportPath,
      labelsPath: files.labelsPath,
      commentsPath: files.commentsPath,
      repository: "dinkuskit/blocks",
      repositoryId: 1306882611,
      itemNumber: 7,
      baseSha: BASE,
      headSha: HEAD,
      engineSha: ENGINE,
      generatedAt: GENERATED_AT,
      now: NOW,
    });
    assert.equal(result.outputPath, join(stateRoot, ...TELEMETRY_RELATIVE_PATH.split("/")));
    const written = JSON.parse(readFileSync(result.outputPath, "utf8"));
    consumerAccepts(written);
    assert.equal(written.tenant, "dinkuskit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI writes the envelope and refuses credentialed environments", () => {
  const root = fixtureRoot();
  const stateRoot = join(root, "state");
  mkdirSync(stateRoot, { recursive: true });
  try {
    const files = writeInputs(root);
    const result = spawnSync(process.execPath, [
      SCRIPT,
      "--state-root",
      stateRoot,
      "--report",
      files.reportPath,
      "--labels",
      files.labelsPath,
      "--comments",
      files.commentsPath,
      "--repository",
      "dinkuskit/blocks",
      "--repository-id",
      "1306882611",
      "--item-number",
      "7",
      "--base-sha",
      BASE,
      "--head-sha",
      HEAD,
      "--engine-sha",
      ENGINE,
    ]);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.match(result.stdout.toString(), /dinkuskit/);
    const blocked = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--state-root",
        stateRoot,
        "--report",
        files.reportPath,
        "--repository",
        "dinkuskit/blocks",
        "--repository-id",
        "1306882611",
        "--item-number",
        "7",
        "--base-sha",
        BASE,
        "--head-sha",
        HEAD,
        "--engine-sha",
        ENGINE,
      ],
      { env: { ...process.env, COPILOT_GITHUB_TOKEN: "ghs_must_never_escape" } },
    );
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr.toString(), /must not run with model or App credentials/);
    assert.doesNotMatch(blocked.stderr.toString(), /ghs_must_never_escape/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [name, mutate, message] of [
  [
    "cross-tenant existing envelope",
    () => ({ existingEnvelope: existingEnvelope([existingRow()], { tenant: "saari" }) }),
    /tenant is not dinkuskit/,
  ],
  [
    "untrusted extra envelope field",
    () => ({ existingEnvelope: existingEnvelope([existingRow()], { github_token: "secret" }) }),
    /untrusted or missing fields/,
  ],
  [
    "cross-tenant existing row",
    () => ({
      existingEnvelope: existingEnvelope([existingRow({ repository: "saari-co/x-api" })]),
    }),
    /not an admitted DinkusKit review/,
  ],
  ["repository and ID mismatch", () => ({ repositoryId: 1 }), /repository ID does not match/],
  [
    "future generated_at",
    () => ({ generatedAt: "2026-09-17T18:05:00Z" }),
    /generated_at is malformed or in the future/,
  ],
  [
    "local proof path in existing row",
    () => ({
      existingEnvelope: existingEnvelope([
        existingRow({ proof_links: ["/Users/cp-1/secret/PROOF.md"] }),
      ]),
    }),
    /private payload, secret, or local path|proof_links/,
  ],
] as const) {
  test(`fail-closed publisher rejects ${name}`, () => {
    const root = fixtureRoot();
    try {
      assert.throws(() => publish(root, mutate()), message);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("fail-closed publisher rejects a symlink telemetry file", () => {
  const root = fixtureRoot();
  const stateRoot = join(root, "state");
  const outputDir = join(stateRoot, "results", "review-telemetry");
  mkdirSync(outputDir, { recursive: true });
  const target = join(root, "escaped.json");
  writeFileSync(target, "{}\n");
  symlinkSync(target, join(outputDir, "dinkuskit.json"));
  try {
    const files = writeInputs(root);
    assert.throws(
      () =>
        writeDinkuskitReviewTelemetry({
          stateRoot,
          reportPath: files.reportPath,
          labelsPath: files.labelsPath,
          commentsPath: files.commentsPath,
          repository: "dinkuskit/blocks",
          repositoryId: 1306882611,
          itemNumber: 7,
          baseSha: BASE,
          headSha: HEAD,
          engineSha: ENGINE,
          generatedAt: GENERATED_AT,
          now: NOW,
        }),
      /symlink/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fail-closed publisher rejects an oversized existing envelope", () => {
  const root = fixtureRoot();
  const stateRoot = join(root, "state");
  const outputDir = join(stateRoot, "results", "review-telemetry");
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "dinkuskit.json"), `${"x".repeat(MAX_BODY_BYTES + 1)}\n`);
  try {
    const files = writeInputs(root);
    assert.throws(
      () =>
        writeDinkuskitReviewTelemetry({
          stateRoot,
          reportPath: files.reportPath,
          labelsPath: files.labelsPath,
          commentsPath: files.commentsPath,
          repository: "dinkuskit/blocks",
          repositoryId: 1306882611,
          itemNumber: 7,
          baseSha: BASE,
          headSha: HEAD,
          engineSha: ENGINE,
          generatedAt: GENERATED_AT,
          now: NOW,
        }),
      /outside the telemetry bound/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fail-closed publisher rejects a 501st distinct row instead of dropping evidence", () => {
  const root = fixtureRoot();
  try {
    const rows = Array.from({ length: MAX_ROWS }, (_, index) =>
      existingRow({
        repository: "dinkuskit/inventory",
        pr_number: index + 1,
        head_sha: `${index.toString(16).padStart(40, "0")}`,
      }),
    );
    assert.throws(
      () => publish(root, { existingEnvelope: existingEnvelope(rows) }),
      /consumer cap/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
