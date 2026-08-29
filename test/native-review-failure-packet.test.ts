import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  collectNativeReviewFailurePacket,
  FAILURE_CATEGORIES,
} from "../scripts/collect-native-review-failure-packet.mjs";

const collectorPath = resolve("scripts/collect-native-review-failure-packet.mjs");
const tmpPrefix = join(tmpdir(), "clawsweeper-native-review-failure-packet-");

const ENGINE_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const HEAD_SHA = "c".repeat(40);
const MERGE_BASE_SHA = "d".repeat(40);

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    itemNumber: 7,
    targetRepo: "dinkuskit/blocks",
    engineSha: ENGINE_SHA,
    baseRef: "main",
    baseSha: BASE_SHA,
    headRepo: "dinkuskit/blocks",
    headSha: HEAD_SHA,
    mergeBaseSha: MERGE_BASE_SHA,
    runId: "123456",
    runAttempt: "1",
    ...overrides,
  };
}

function allOutputText(outputDir: string): string {
  return readdirSync(outputDir)
    .map((name) => readFileSync(join(outputDir, name), "utf8"))
    .join("\n");
}

test("Copilot nonzero exit with stderr: re-serializes the diagnostic and tail-caps the log without leaking planted secrets", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const artifactDir = join(root, "artifacts");
    const outputDir = join(root, "packet");
    mkdirSync(join(artifactDir, "codex"), { recursive: true });
    writeFileSync(
      join(artifactDir, "codex", "copilot-failure.json"),
      JSON.stringify({
        category: "unclassified",
        exit_status: 7,
        kind: "clawsweeper_copilot_failure",
      }),
    );
    const plantedPatToken = `github_pat_FAKE${"0".repeat(30)}`;
    const padding = "x".repeat(70_000);
    const stderrContent = `${padding}\nCOPILOT_GITHUB_TOKEN=fake-secret-value ${plantedPatToken}\n`;
    writeFileSync(join(artifactDir, "codex", "7.1.codex.stderr.log"), stderrContent);

    const result = collectNativeReviewFailurePacket(baseOptions({ artifactDir, outputDir }));

    assert.equal(result.failure_category, "unclassified");
    assert.equal(result.metadata.adapter_exit_status, 7);

    const diagnostic = JSON.parse(readFileSync(join(outputDir, "copilot-failure.json"), "utf8"));
    assert.deepEqual(diagnostic, {
      category: "unclassified",
      exit_status: 7,
      kind: "clawsweeper_copilot_failure",
    });

    const stderrLog = readFileSync(join(outputDir, "7.1.codex.stderr.log"), "utf8");
    assert.match(stderrLog, /^\[truncated: kept last \d+ of \d+ bytes\]\n/);

    const logMeta = result.metadata.files.find(
      (file: { name: string }) => file.name === "7.1.codex.stderr.log",
    );
    assert.ok(logMeta, "expected the stderr log in packet metadata");
    assert.equal(logMeta.truncated, true);

    const everything = allOutputText(outputDir);
    assert.doesNotMatch(everything, new RegExp(plantedPatToken));
    assert.doesNotMatch(everything, /fake-secret-value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing tool submission: response_contract category flows through metadata", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const artifactDir = join(root, "artifacts");
    const outputDir = join(root, "packet");
    mkdirSync(join(artifactDir, "codex"), { recursive: true });
    writeFileSync(
      join(artifactDir, "codex", "copilot-failure.json"),
      JSON.stringify({
        category: "response_contract",
        exit_status: 0,
        kind: "clawsweeper_copilot_failure",
      }),
    );

    const result = collectNativeReviewFailurePacket(baseOptions({ artifactDir, outputDir }));
    assert.equal(result.failure_category, "response_contract");
    assert.equal(result.metadata.adapter_exit_status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapter_handoff: invalid adapter-status JSON is noted, not copied", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const artifactDir = join(root, "artifacts");
    const outputDir = join(root, "packet");
    mkdirSync(join(artifactDir, "codex"), { recursive: true });
    writeFileSync(join(artifactDir, "codex", "copilot-adapter-status.json"), "not-json{{{");

    const result = collectNativeReviewFailurePacket(baseOptions({ artifactDir, outputDir }));
    assert.equal(result.failure_category, "adapter_handoff");
    assert.ok(!readdirSync(outputDir).includes("copilot-adapter-status.json"));
    assert.ok(
      result.metadata.notes.some((note: string) => /copilot-adapter-status\.json/.test(note)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native_postprocess: valid accepted status plus native output and partial report", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const artifactDir = join(root, "artifacts");
    const outputDir = join(root, "packet");
    mkdirSync(join(artifactDir, "codex"), { recursive: true });
    writeFileSync(
      join(artifactDir, "codex", "copilot-adapter-status.json"),
      JSON.stringify({ kind: "clawsweeper_copilot_adapter", status: "accepted" }),
    );
    writeFileSync(join(artifactDir, "codex", "7.json"), JSON.stringify({ decision: "keep_open" }));
    writeFileSync(join(artifactDir, "7.md"), "---\nreview_status: partial\n---\n\nPartial body.\n");

    const result = collectNativeReviewFailurePacket(baseOptions({ artifactDir, outputDir }));
    assert.equal(result.failure_category, "native_postprocess");
    const partial = readFileSync(join(outputDir, "partial-native-report.md"), "utf8");
    assert.match(partial, /Partial body/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing everything: nonexistent artifact dir still writes a clean adapter_boundary packet", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const artifactDir = join(root, "does-not-exist");
    const outputDir = join(root, "packet");

    const result = collectNativeReviewFailurePacket(baseOptions({ artifactDir, outputDir }));
    assert.equal(result.failure_category, "adapter_boundary");
    assert.equal(result.metadata.artifact_dir_present, false);
    assert.ok(result.metadata.notes.length > 0);
    assert.ok(readdirSync(outputDir).includes("metadata.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("redaction and byte caps: oversized report, PEM/JWT/URL redaction, symlink skip, and total-byte-cap enforcement", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const artifactDir = join(root, "artifacts");
    const outputDir = join(root, "packet");
    mkdirSync(join(artifactDir, "codex"), { recursive: true });

    const oversizedReport = `---\nreview_status: partial\n---\n\n${"y".repeat(140_000)}\n`;
    writeFileSync(join(artifactDir, "7.md"), oversizedReport);

    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "ZmFrZS1rZXktbWF0ZXJpYWwtdGhhdC1pcy1ub3QtcmVhbA==",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQrestOfSignature";
    const urlWithUserinfo = "https://x-access-token:abc@github.com/dinkuskit/blocks.git";
    writeFileSync(
      join(artifactDir, "codex", "7.1.codex.stdout.log"),
      `${pem}\n${jwt}\n${urlWithUserinfo}\n`,
    );

    const result = collectNativeReviewFailurePacket(
      baseOptions({ artifactDir, outputDir: join(outputDir, "full") }),
    );
    const fullReport = readFileSync(join(outputDir, "full", "partial-native-report.md"), "utf8");
    assert.match(fullReport, /\[truncated: kept first \d+ of \d+ bytes\]$/);
    const fullLog = readFileSync(join(outputDir, "full", "7.1.codex.stdout.log"), "utf8");
    assert.doesNotMatch(fullLog, /-----BEGIN PRIVATE KEY-----[\s\S]*ZmFrZS1rZXk/);
    assert.match(fullLog, /\[REDACTED_PRIVATE_KEY\]/);
    assert.match(fullLog, /\[REDACTED_JWT\]/);
    assert.doesNotMatch(fullLog, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
    assert.match(fullLog, /:\/\/\[REDACTED\]@github\.com/);
    assert.doesNotMatch(fullLog, /x-access-token:abc@/);
    assert.equal(result.failure_category, "adapter_boundary");

    // Symlinked log file must be skipped entirely (untrusted artifact tree).
    const symlinkOutputDir = join(outputDir, "symlink");
    const linkTarget = join(root, "outside-secret.txt");
    writeFileSync(linkTarget, "COPILOT_GITHUB_TOKEN=should-never-be-copied\n");
    symlinkSync(linkTarget, join(artifactDir, "codex", "7.2.codex.stderr.log"));
    const symlinkResult = collectNativeReviewFailurePacket(
      baseOptions({ artifactDir, outputDir: symlinkOutputDir }),
    );
    assert.ok(!readdirSync(symlinkOutputDir).includes("7.2.codex.stderr.log"));
    assert.doesNotMatch(allOutputText(symlinkOutputDir), /should-never-be-copied/);
    assert.ok(symlinkResult.metadata.notes.length > 0);

    // Total-byte-cap enforcement: a small total cap forces later files to be skipped.
    const cappedArtifactDir = join(root, "capped-artifacts");
    mkdirSync(join(cappedArtifactDir, "codex"), { recursive: true });
    writeFileSync(
      join(cappedArtifactDir, "codex", "copilot-failure.json"),
      JSON.stringify({
        category: "execution",
        exit_status: 3,
        kind: "clawsweeper_copilot_failure",
      }),
    );
    writeFileSync(join(cappedArtifactDir, "codex", "7.1.codex.stderr.log"), "z".repeat(500));
    const cappedOutputDir = join(outputDir, "capped");
    const cappedResult = collectNativeReviewFailurePacket(
      baseOptions({
        artifactDir: cappedArtifactDir,
        outputDir: cappedOutputDir,
        caps: { totalCopied: 32 },
      }),
    );
    const skippedFile = cappedResult.metadata.files.find(
      (file: { name: string; skipped?: boolean }) => file.name === "7.1.codex.stderr.log",
    );
    assert.ok(skippedFile);
    assert.equal(skippedFile.skipped, true);
    assert.ok(!readdirSync(cappedOutputDir).includes("7.1.codex.stderr.log"));
    assert.ok(
      cappedResult.metadata.notes.some((note: string) => /total copied-content cap/.test(note)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failure categories stay consistent with the workflow jq allowlist and the adapter's recorded literals", () => {
  const workflowSource = readFileSync(".github/workflows/dinkuskit-native-canary.yml", "utf8");
  const inMatch = workflowSource.match(/\.category \| IN\(([\s\S]*?)\)\)/);
  assert.ok(inMatch, "expected the jq category IN(...) allowlist");
  const workflowCategories = [...inMatch[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...workflowCategories].sort(), [...FAILURE_CATEGORIES].sort());

  const adapterSource = readFileSync("scripts/run-copilot-codex-adapter.mjs", "utf8");
  const returnCategories = [...adapterSource.matchAll(/return "([a-z_]+)";/g)].map(
    (match) => match[1],
  );
  const recordedCategories = [
    ...adapterSource.matchAll(/(?<!function )recordCopilotFailure\(([\s\S]*?)\);/g),
  ]
    .map((call) => call[1].match(/"([a-z_]+)"/)?.[1])
    .filter((category): category is string => Boolean(category));
  const adapterCategories = new Set([...returnCategories, ...recordedCategories]);
  assert.ok(adapterCategories.size > 0);
  for (const category of adapterCategories) {
    assert.ok(
      FAILURE_CATEGORIES.includes(category as (typeof FAILURE_CATEGORIES)[number]),
      category,
    );
  }
  for (const expected of [
    "authentication",
    "copilot_access",
    "model_access",
    "cli_contract",
    "response_contract",
    "network",
    "rate_limited",
    "server_error",
    "execution",
    "unclassified",
  ]) {
    assert.ok(adapterCategories.has(expected), expected);
  }
});

test("credential-env guard: the CLI refuses to run with COPILOT_GITHUB_TOKEN set and writes nothing", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const artifactDir = join(root, "artifacts");
    const outputDir = join(root, "packet");
    mkdirSync(artifactDir, { recursive: true });

    const args = [
      "--artifact-dir",
      artifactDir,
      "--output-dir",
      outputDir,
      "--item-number",
      "7",
      "--target-repo",
      "dinkuskit/blocks",
      "--engine-sha",
      ENGINE_SHA,
      "--base-ref",
      "main",
      "--base-sha",
      BASE_SHA,
      "--head-repo",
      "dinkuskit/blocks",
      "--head-sha",
      HEAD_SHA,
      "--merge-base-sha",
      MERGE_BASE_SHA,
      "--run-id",
      "123456",
      "--run-attempt",
      "1",
    ];
    const result = spawnSync(process.execPath, [collectorPath, ...args], {
      env: { ...process.env, COPILOT_GITHUB_TOKEN: "fake-token-value" },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.throws(() => readdirSync(outputDir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("happy-path CLI spawn: no credentials in env, parseArgs wires flags through, exits 0 with JSON on stdout", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const artifactDir = join(root, "artifacts");
    const outputDir = join(root, "packet");
    mkdirSync(artifactDir, { recursive: true });

    const cleanEnv = { ...process.env };
    delete cleanEnv.COPILOT_GITHUB_TOKEN;

    const args = [
      "--artifact-dir",
      artifactDir,
      "--output-dir",
      outputDir,
      "--item-number",
      "7",
      "--target-repo",
      "dinkuskit/blocks",
      "--engine-sha",
      ENGINE_SHA,
      "--base-ref",
      "main",
      "--base-sha",
      BASE_SHA,
      "--head-repo",
      "dinkuskit/blocks",
      "--head-sha",
      HEAD_SHA,
      "--merge-base-sha",
      MERGE_BASE_SHA,
      "--run-id",
      "123456",
      "--run-attempt",
      "1",
      "--review-started-at",
      "",
      "--review-exit-status",
      "",
    ];
    const result = spawnSync(process.execPath, [collectorPath, ...args], {
      env: cleanEnv,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const stdout = JSON.parse(result.stdout.trim());
    assert.equal(stdout.output_dir, outputDir);
    assert.ok(FAILURE_CATEGORIES.includes(stdout.failure_category));
    assert.ok(readdirSync(outputDir).includes("metadata.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
