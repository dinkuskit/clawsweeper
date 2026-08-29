#!/usr/bin/env node

import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CREDENTIAL_ENV_GUARD_MESSAGE =
  "the failure packet collector must not run with model credentials in the environment";

export const FAILURE_CATEGORIES = Object.freeze([
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
  "native_postprocess",
  "adapter_handoff",
  "adapter_boundary",
]);

const DEFAULT_CAPS = Object.freeze({
  diagnosticJson: 4096,
  logTail: 65536,
  reportHead: 131072,
  nativeOutput: 65536,
  totalCopied: 1048576,
});

const MAX_ADAPTER_ATTEMPTS = 5;

function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(
      /\b(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN|CLAWSWEEPER_APP_PRIVATE_KEY)=[^\s"']+/g,
      "$1=[REDACTED]",
    )
    .replace(
      /"(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN)"\s*:\s*"[^"]*"/g,
      '"$1":"[REDACTED]"',
    )
    .replace(
      /\b(authorization|proxy-authorization)\s*:\s*(?:bearer|basic|token)\s+\S+/gi,
      "$1: [REDACTED]",
    )
    .replace(/(:\/\/)[^/\s@]+@/g, "$1[REDACTED]@")
    .replace(
      /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[REDACTED_JWT]",
    );
}

function decodeLossy(buffer) {
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

function regularUntrustedFile(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return stat;
  } catch {
    return null;
  }
}

function readBoundedTail(path, cap) {
  const stat = regularUntrustedFile(path);
  if (!stat) return null;
  const size = stat.size;
  if (size <= 0) return { bytes: Buffer.alloc(0), originalBytes: 0, truncated: false };
  const kept = Math.min(size, cap);
  const start = size - kept;
  let buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return null;
  }
  const slice = buffer.subarray(start);
  return { bytes: slice, originalBytes: size, truncated: size > cap };
}

function readBoundedHead(path, cap) {
  const stat = regularUntrustedFile(path);
  if (!stat) return null;
  const size = stat.size;
  if (size <= 0) return { bytes: Buffer.alloc(0), originalBytes: 0, truncated: false };
  let buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return null;
  }
  const kept = Math.min(size, cap);
  const slice = buffer.subarray(0, kept);
  return { bytes: slice, originalBytes: size, truncated: size > cap };
}

function readBoundedJson(path, cap) {
  const stat = regularUntrustedFile(path);
  if (!stat) return { present: false };
  if (stat.size <= 0 || stat.size > cap) return { present: true, valid: false };
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { present: true, valid: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { present: true, valid: false };
  }
  return { present: true, valid: true, parsed };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && expected.every((key, index) => keys[index] === key);
}

function validCopilotFailure(parsed) {
  if (!isPlainObject(parsed)) return false;
  if (!sameKeys(parsed, ["category", "exit_status", "kind"])) return false;
  if (parsed.kind !== "clawsweeper_copilot_failure") return false;
  if (!FAILURE_CATEGORIES.includes(parsed.category)) return false;
  if (parsed.exit_status !== null && !Number.isInteger(parsed.exit_status)) return false;
  return true;
}

function validAdapterStatus(parsed) {
  if (!isPlainObject(parsed)) return false;
  if (!sameKeys(parsed, ["kind", "status"])) return false;
  return parsed.kind === "clawsweeper_copilot_adapter" && parsed.status === "accepted";
}

class ByteBudget {
  constructor(cap) {
    this.remaining = cap;
  }

  reserve(bytes) {
    if (bytes > this.remaining) return false;
    this.remaining -= bytes;
    return true;
  }
}

export function collectNativeReviewFailurePacket(options = {}) {
  if (String(process.env.COPILOT_GITHUB_TOKEN ?? "").length > 0) {
    throw new Error(CREDENTIAL_ENV_GUARD_MESSAGE);
  }

  const caps = { ...DEFAULT_CAPS, ...options.caps };

  const artifactDir = String(options.artifactDir ?? "").trim();
  const outputDir = String(options.outputDir ?? "").trim();
  const itemNumber = Number(options.itemNumber);
  const targetRepo = String(options.targetRepo ?? "").trim();
  const engineSha = String(options.engineSha ?? "").trim();
  const baseRef = String(options.baseRef ?? "").trim();
  const baseSha = String(options.baseSha ?? "").trim();
  const headRepo = String(options.headRepo ?? "").trim();
  const headSha = String(options.headSha ?? "").trim();
  const mergeBaseSha = String(options.mergeBaseSha ?? "").trim();
  const runId = String(options.runId ?? "").trim();
  const runAttempt = String(options.runAttempt ?? "").trim();
  const reviewStartedAtRaw = options.reviewStartedAt;
  const reviewExitStatusRaw = options.reviewExitStatus;

  if (!outputDir) throw new Error("output directory is required");
  if (!Number.isSafeInteger(itemNumber) || itemNumber <= 0) {
    throw new Error("item number must be a positive integer");
  }
  if (!SHA_PATTERN.test(engineSha)) throw new Error("engine SHA is invalid");
  if (!SHA_PATTERN.test(baseSha)) throw new Error("base SHA is invalid");
  if (!SHA_PATTERN.test(headSha)) throw new Error("head SHA is invalid");
  if (!SHA_PATTERN.test(mergeBaseSha)) throw new Error("merge-base SHA is invalid");
  if (!REPOSITORY_PATTERN.test(targetRepo)) throw new Error("target repository is invalid");
  if (!REPOSITORY_PATTERN.test(headRepo)) throw new Error("head repository is invalid");
  if (!baseRef) throw new Error("base ref is required");

  let reviewStartedAt = null;
  if (
    reviewStartedAtRaw !== undefined &&
    reviewStartedAtRaw !== null &&
    reviewStartedAtRaw !== ""
  ) {
    const parsed = Number(reviewStartedAtRaw);
    if (!Number.isFinite(parsed)) throw new Error("review started-at must be an epoch number");
    reviewStartedAt = parsed;
  }

  let reviewExitStatus = null;
  if (
    reviewExitStatusRaw !== undefined &&
    reviewExitStatusRaw !== null &&
    reviewExitStatusRaw !== ""
  ) {
    const parsed = Number(reviewExitStatusRaw);
    if (!Number.isInteger(parsed)) throw new Error("review exit status must be an integer");
    reviewExitStatus = parsed;
  }

  mkdirSync(outputDir, { recursive: true });

  const notes = [];
  const files = [];
  const budget = new ByteBudget(caps.totalCopied);

  const artifactDirPresent = (() => {
    try {
      return lstatSync(artifactDir).isDirectory();
    } catch {
      return false;
    }
  })();

  function writeCopiedFile(name, source, content, meta) {
    const bytes = Buffer.byteLength(content);
    if (!budget.reserve(bytes)) {
      notes.push(`skipped ${name}: total copied-content cap would be exceeded`);
      files.push({
        name,
        source,
        bytes: 0,
        original_bytes: meta.originalBytes ?? 0,
        truncated: false,
        redacted: meta.redacted ?? false,
        skipped: true,
      });
      return;
    }
    writeFileSync(join(outputDir, name), content, "utf8");
    files.push({
      name,
      source,
      bytes,
      original_bytes: meta.originalBytes ?? bytes,
      truncated: meta.truncated ?? false,
      redacted: meta.redacted ?? false,
    });
  }

  // 1. codex/copilot-failure.json
  const failurePath = join(artifactDir, "codex", "copilot-failure.json");
  const failureRead = readBoundedJson(failurePath, caps.diagnosticJson);
  let copilotFailure = null;
  if (failureRead.present && failureRead.valid && validCopilotFailure(failureRead.parsed)) {
    copilotFailure = failureRead.parsed;
    const reserialized = `${JSON.stringify({
      category: copilotFailure.category,
      exit_status: copilotFailure.exit_status,
      kind: copilotFailure.kind,
    })}\n`;
    writeCopiedFile("copilot-failure.json", "codex/copilot-failure.json", reserialized, {
      originalBytes: Buffer.byteLength(reserialized),
      truncated: false,
      redacted: false,
    });
  } else if (failureRead.present) {
    notes.push("codex/copilot-failure.json was present but did not satisfy the bounded contract");
  } else {
    notes.push("codex/copilot-failure.json was not present");
  }

  // 2. codex/copilot-adapter-status.json
  const statusPath = join(artifactDir, "codex", "copilot-adapter-status.json");
  const statusRead = readBoundedJson(statusPath, caps.diagnosticJson);
  let adapterStatusValid = false;
  if (statusRead.present && statusRead.valid && validAdapterStatus(statusRead.parsed)) {
    adapterStatusValid = true;
    const reserialized = `${JSON.stringify({
      kind: statusRead.parsed.kind,
      status: statusRead.parsed.status,
    })}\n`;
    writeCopiedFile(
      "copilot-adapter-status.json",
      "codex/copilot-adapter-status.json",
      reserialized,
      { originalBytes: Buffer.byteLength(reserialized), truncated: false, redacted: false },
    );
  } else if (statusRead.present) {
    notes.push(
      "codex/copilot-adapter-status.json was present but did not satisfy the bounded contract",
    );
  } else {
    notes.push("codex/copilot-adapter-status.json was not present");
  }

  // 3. adapter logs for attempts 1..5
  for (let attempt = 1; attempt <= MAX_ADAPTER_ATTEMPTS; attempt += 1) {
    for (const stream of ["stdout", "stderr"]) {
      const logName = `${itemNumber}.${attempt}.codex.${stream}.log`;
      const logPath = join(artifactDir, "codex", logName);
      const tail = readBoundedTail(logPath, caps.logTail);
      if (!tail) continue;
      if (tail.originalBytes === 0) {
        notes.push(`codex/${logName} was empty`);
        continue;
      }
      let text = redactSensitiveText(decodeLossy(tail.bytes));
      if (tail.truncated) {
        text = `[truncated: kept last ${tail.bytes.length} of ${tail.originalBytes} bytes]\n${text}`;
      }
      writeCopiedFile(logName, `codex/${logName}`, text, {
        originalBytes: tail.originalBytes,
        truncated: tail.truncated,
        redacted: true,
      });
    }
  }

  // 4. partial native report <item>.md at artifact root
  const reportPath = join(artifactDir, `${itemNumber}.md`);
  const reportHead = readBoundedHead(reportPath, caps.reportHead);
  if (reportHead) {
    if (reportHead.originalBytes === 0) {
      notes.push(`${itemNumber}.md was empty`);
    } else {
      let text = redactSensitiveText(decodeLossy(reportHead.bytes));
      if (reportHead.truncated) {
        text = `${text}\n[truncated: kept first ${reportHead.bytes.length} of ${reportHead.originalBytes} bytes]`;
      }
      writeCopiedFile("partial-native-report.md", `${itemNumber}.md`, text, {
        originalBytes: reportHead.originalBytes,
        truncated: reportHead.truncated,
        redacted: true,
      });
    }
  } else {
    notes.push(`${itemNumber}.md was not present`);
  }

  // 5. native decision output codex/<item>.json
  const nativeOutputPath = join(artifactDir, "codex", `${itemNumber}.json`);
  const nativeOutputStat = regularUntrustedFile(nativeOutputPath);
  const nativeOutputHead = readBoundedHead(nativeOutputPath, caps.nativeOutput);
  if (nativeOutputHead) {
    if (nativeOutputHead.originalBytes === 0) {
      notes.push(`codex/${itemNumber}.json was empty`);
    } else {
      let text = decodeLossy(nativeOutputHead.bytes);
      if (nativeOutputHead.truncated) {
        notes.push(`codex/${itemNumber}.json was truncated to its bounded cap`);
      }
      text = redactSensitiveText(text);
      writeCopiedFile("native-decision-output.json", `codex/${itemNumber}.json`, text, {
        originalBytes: nativeOutputHead.originalBytes,
        truncated: nativeOutputHead.truncated,
        redacted: true,
      });
    }
  } else {
    notes.push(`codex/${itemNumber}.json was not present`);
  }

  // failure_category resolution
  let failureCategory;
  if (copilotFailure) {
    failureCategory = copilotFailure.category;
  } else if (failureRead.present) {
    failureCategory = "unclassified";
  } else if (adapterStatusValid && nativeOutputStat) {
    failureCategory = "native_postprocess";
  } else if (statusRead.present) {
    failureCategory = "adapter_handoff";
  } else {
    failureCategory = "adapter_boundary";
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  const reviewElapsedSeconds =
    reviewStartedAt === null ? null : Math.max(0, Math.floor(nowEpoch - reviewStartedAt));

  const metadata = {
    kind: "clawsweeper_native_review_failure_packet",
    captured_at: new Date().toISOString(),
    engine_sha: engineSha,
    target_repo: targetRepo,
    item_number: itemNumber,
    base_ref: baseRef,
    base_sha: baseSha,
    head_repo: headRepo,
    head_sha: headSha,
    merge_base_sha: mergeBaseSha,
    run_id: runId,
    run_attempt: runAttempt,
    review_started_at: reviewStartedAt,
    review_elapsed_seconds: reviewElapsedSeconds,
    review_exit_status: reviewExitStatus,
    adapter_exit_status: copilotFailure ? copilotFailure.exit_status : null,
    failure_category: failureCategory,
    artifact_dir_present: artifactDirPresent,
    files,
    notes,
  };

  writeFileSync(join(outputDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  return {
    output_dir: outputDir,
    file_count: files.length,
    failure_category: failureCategory,
    metadata,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: collect-native-review-failure-packet.mjs --artifact-dir DIR --output-dir DIR --item-number N --target-repo OWNER/REPO --engine-sha SHA --base-ref REF --base-sha SHA --head-repo OWNER/REPO --head-sha SHA --merge-base-sha SHA --run-id ID --run-attempt N [--review-started-at EPOCH] [--review-exit-status N]",
      );
    }
    values[key.slice(2)] = value;
  }
  return values;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (String(process.env.COPILOT_GITHUB_TOKEN ?? "").length > 0) {
      throw new Error(CREDENTIAL_ENV_GUARD_MESSAGE);
    }
    const args = parseArgs(process.argv.slice(2));
    const result = collectNativeReviewFailurePacket({
      artifactDir: args["artifact-dir"],
      outputDir: args["output-dir"],
      itemNumber: args["item-number"],
      targetRepo: args["target-repo"],
      engineSha: args["engine-sha"],
      baseRef: args["base-ref"],
      baseSha: args["base-sha"],
      headRepo: args["head-repo"],
      headSha: args["head-sha"],
      mergeBaseSha: args["merge-base-sha"],
      runId: args["run-id"],
      runAttempt: args["run-attempt"],
      reviewStartedAt: args["review-started-at"],
      reviewExitStatus: args["review-exit-status"],
    });
    process.stdout.write(
      `${JSON.stringify({
        output_dir: result.output_dir,
        file_count: result.file_count,
        failure_category: result.failure_category,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `collect-native-review-failure-packet: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
