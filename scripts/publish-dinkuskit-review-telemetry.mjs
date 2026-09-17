#!/usr/bin/env node

/**
 * Build the DinkusKit clawsweeper.telemetry.v1 envelope from trusted native-canary
 * admission, report, and publication facts. Writes only
 * results/review-telemetry/dinkuskit.json under --state-root. Does not push,
 * call GitHub, or invent missing CI/OpenClaw/ClawSweeper conclusions.
 */

import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateDinkuskitCanaryReport } from "./validate-dinkuskit-canary-report.mjs";

export const SCHEMA_VERSION = "clawsweeper.telemetry.v1";
export const TENANT = "dinkuskit";
export const MAX_ROWS = 500;
export const MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_STALE_AFTER_SECONDS = 900;
export const MAX_FUTURE_SKEW_MS = 60_000;
export const TELEMETRY_RELATIVE_PATH = "results/review-telemetry/dinkuskit.json";
export const EXECUTOR = "dinkuskit-native-canary";
export const SOURCE = "dinkuskit-native-canary";

export const DINKUSKIT_LANE = Object.freeze({
  app_installation: "dinkuskit-clawsweeper[bot]",
  queue_namespace: "dinkuskit-native-clawsweeper-state-writer",
  state_store: "dinkuskit/clawsweeper-state@state",
  mutation_authority: "dinkuskit/clawsweeper native-canary publish job",
});

export const CLAWSWEEPER_RANKS = Object.freeze([
  "S Challenger Crab",
  "A Diamond Lobster",
  "B Platinum Hermit",
  "C Gold Shrimp",
  "D Silver Shellfish",
  "F Unranked Krab",
  "N/A Off-meta Tidepool",
]);

export const ADMITTED_REPOSITORIES = Object.freeze({
  "dinkuskit/blocks": 1306882611,
  "dinkuskit/template-store": 1306882668,
  "dinkuskit/template-services": 1306882701,
  "dinkuskit/template-marketing": 1306882756,
  "dinkuskit/inventory": 1307843786,
  "dinkuskit/coupons": 1307843842,
  "dinkuskit/bundles": 1307843885,
  "dinkuskit/commerce": 1347692514,
});

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CREDENTIAL_ENV_KEYS = Object.freeze([
  "COPILOT_GITHUB_TOKEN",
  "CLAWSWEEPER_APP_PRIVATE_KEY",
  "OPENAI_API_KEY",
]);
const ENVELOPE_KEYS = Object.freeze([
  "schema_version",
  "tenant",
  "generated_at",
  "stale_after_seconds",
  "lane",
  "rows",
]);
const LANE_KEYS = Object.freeze([
  "app_installation",
  "queue_namespace",
  "state_store",
  "mutation_authority",
]);
const ROW_KEYS = Object.freeze([
  "repository",
  "pr_number",
  "base_sha",
  "head_sha",
  "ci",
  "ci_conclusion",
  "openclaw",
  "openclaw_conclusion",
  "clawsweeper",
  "clawsweeper_conclusion",
  "rating",
  "proof_links",
  "engine_sha",
  "executor",
  "findings_total",
  "findings_actionable",
  "observed_at",
  "source",
]);
const RANK_BY_TIER = Object.freeze({
  S: "S Challenger Crab",
  A: "A Diamond Lobster",
  B: "B Platinum Hermit",
  C: "C Gold Shrimp",
  D: "D Silver Shellfish",
  F: "F Unranked Krab",
  NA: "N/A Off-meta Tidepool",
  "N/A": "N/A Off-meta Tidepool",
});
const FORBIDDEN_TEXT =
  /github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|-----BEGIN[A-Z ]*PRIVATE KEY-----|(^|[\s"'])(\/(?:Users|home|opt|tmp|private|var\/folders)\/|[A-Za-z]:\\)/m;
const LOCAL_PATH =
  /(?:^|[\s"'=])(?:\/(?:Users|home|opt|private|var\/folders)\/|[A-Za-z]:\\|\.{1,2}\/)/;
const SECRET_FIELD =
  /^(?:.*(?:token|secret|authorization|password|cookie|header|private[_-]?key).*)$/i;

const USAGE = `Usage:
  node scripts/publish-dinkuskit-review-telemetry.mjs
    --state-root <dir>
    --report <path>
    --repository OWNER/REPO
    --repository-id <id>
    --item-number N
    --base-sha SHA
    --head-sha SHA
    --engine-sha SHA
    [--labels <path>]
    [--comments <path>]
    [--generated-at ISO]
    [--workflow-run-url URL]
    [--stale-after-seconds N]
`;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function nonEmptyString(value, max = 300) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

export function sha(value) {
  const text = nonEmptyString(value, 40);
  return text && SHA_PATTERN.test(text) ? text.toLowerCase() : null;
}

function exactKeys(value, keys, label) {
  const record = object(value);
  if (!record) throw new Error(`${label} must be an object`);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has untrusted or missing fields`);
  }
  return record;
}

function isoDate(value, now) {
  const text = nonEmptyString(value, 80);
  if (!text || !Number.isFinite(Date.parse(text))) return null;
  const timestamp = Date.parse(text);
  if (timestamp > now + MAX_FUTURE_SKEW_MS) return null;
  return new Date(timestamp).toISOString();
}

function httpsLink(value) {
  const text = nonEmptyString(value, 2_000);
  if (!text || LOCAL_PATH.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function githubHttpsLink(value) {
  const link = httpsLink(value);
  if (!link) return null;
  const url = new URL(link);
  return url.hostname === "github.com" ? url.toString() : null;
}

function assertNoForbiddenText(text, label) {
  if (FORBIDDEN_TEXT.test(text) || /authorization\s*:/i.test(text) || /Bearer\s+\S+/i.test(text)) {
    throw new Error(`${label} contains a private payload, secret, or local path`);
  }
}

function regularFile(path, label, maxBytes = MAX_BODY_BYTES) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (stat.size <= 0 || stat.size > maxBytes) {
    throw new Error(`${label} size is outside the telemetry bound`);
  }
  return stat;
}

function readRegularJson(path, label, maxBytes = MAX_BODY_BYTES) {
  regularFile(path, label, maxBytes);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  assertNoForbiddenText(text, label);
  return JSON.parse(text);
}

function readOptionalRegularJson(path, label) {
  if (!path) return null;
  return readRegularJson(path, label);
}

function reportFrontmatter(reportPath) {
  const markdown = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(reportPath));
  assertNoForbiddenText(markdown, "report");
  if (!markdown.startsWith("---\n")) throw new Error("report frontmatter is missing");
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("report frontmatter is missing");
  const fields = new Map();
  for (const line of markdown.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (fields.has(key)) throw new Error(`report has duplicate frontmatter field: ${key}`);
    fields.set(key, line.slice(separator + 1).trim());
  }
  return { markdown, fields };
}

export function mapClawsweeperRank(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (CLAWSWEEPER_RANKS.includes(text)) return text;
  const tier = text
    .replace(/^rating:\s*/i, "")
    .replace(/^overall tier:\s*/i, "")
    .trim();
  if (RANK_BY_TIER[tier]) return RANK_BY_TIER[tier];
  const compact = tier.replace(/[^A-Za-z/]/g, "").toLowerCase();
  const aliases = {
    schallengercrab: "S Challenger Crab",
    challengercrab: "S Challenger Crab",
    adiamondlobster: "A Diamond Lobster",
    diamondlobster: "A Diamond Lobster",
    bplatinumhermit: "B Platinum Hermit",
    platinumhermit: "B Platinum Hermit",
    cgoldshrimp: "C Gold Shrimp",
    goldshrimp: "C Gold Shrimp",
    dsilvershellfish: "D Silver Shellfish",
    silvershellfish: "D Silver Shellfish",
    funrankedkrab: "F Unranked Krab",
    unrankedkrab: "F Unranked Krab",
    naoffmetatidepool: "N/A Off-meta Tidepool",
    "n/aoffmetatidepool": "N/A Off-meta Tidepool",
    offmetatidepool: "N/A Off-meta Tidepool",
  };
  return aliases[compact] ?? null;
}

function parseVerdict(markdown, itemNumber, headSha) {
  const matches = [...markdown.matchAll(/<!--\s+clawsweeper-verdict:([^\s>]+)\b([^>]*)-->/g)];
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new Error("report has multiple ClawSweeper verdict markers");
  const verdict = String(matches[0][1] ?? "")
    .trim()
    .toLowerCase();
  const attrs = String(matches[0][2] ?? "");
  const item = /(?:^|\s)item=([1-9][0-9]*)/.exec(attrs);
  const shaMatch = /(?:^|\s)sha=([0-9a-f]{40})/.exec(attrs);
  if (item && Number(item[1]) !== itemNumber) {
    throw new Error("report verdict item does not match the admitted review");
  }
  if (shaMatch && shaMatch[1] !== headSha) {
    throw new Error("report verdict SHA does not match the admitted head");
  }
  return verdict || null;
}

function clawsweeperFromReport(reviewStatus, verdict) {
  if (reviewStatus !== "complete") {
    throw new Error("report review_status is not a published complete review");
  }
  if (verdict === "pass") return { clawsweeper: "completed", clawsweeper_conclusion: "success" };
  if (verdict === "needs-changes" || verdict === "needs-repair") {
    return { clawsweeper: "completed", clawsweeper_conclusion: "failure" };
  }
  if (verdict === "needs-human" || verdict === "human-review") {
    return { clawsweeper: "completed", clawsweeper_conclusion: "blocked" };
  }
  return { clawsweeper: "completed", clawsweeper_conclusion: null };
}

function ratingFromInputs(fields, labels) {
  const fromFrontmatter = mapClawsweeperRank(fields.get("pr_rating_overall"));
  const fromLabels = [];
  for (const label of labels) {
    if (!/^rating:/i.test(label)) continue;
    const mapped = mapClawsweeperRank(label);
    if (mapped) fromLabels.push(mapped);
  }
  const uniqueLabels = [...new Set(fromLabels)];
  if (uniqueLabels.length > 1) throw new Error("labels contain conflicting ClawSweeper ratings");
  const fromLabel = uniqueLabels[0] ?? null;
  if (fromFrontmatter && fromLabel && fromFrontmatter !== fromLabel) {
    throw new Error("report rating does not match the published rating label");
  }
  return fromFrontmatter ?? fromLabel;
}

function normalizedLabels(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("labels must be an array of strings");
  }
  const labels = value.map((entry) => entry.trim()).filter(Boolean);
  if (labels.some((entry) => SECRET_FIELD.test(entry) || LOCAL_PATH.test(entry))) {
    throw new Error("labels contain an untrusted field");
  }
  return labels;
}

function commentProofLink(comments, itemNumber, fields) {
  if (comments == null) {
    return githubHttpsLink(fields.get("review_comment_url"));
  }
  if (!Array.isArray(comments)) throw new Error("comments must be an array");
  const marker = `<!-- clawsweeper-review item=${itemNumber} -->`;
  const matching = comments.filter((comment) => {
    const body = typeof comment?.body === "string" ? comment.body : "";
    return body.includes(marker);
  });
  if (matching.length !== 1) throw new Error("expected exactly one native review comment");
  const url = githubHttpsLink(matching[0]?.html_url);
  const recorded = githubHttpsLink(fields.get("review_comment_url"));
  if (!url || !recorded || url !== recorded) {
    throw new Error("published comment URL does not match the state record");
  }
  return url;
}

function proofLinksFor(options) {
  const links = [];
  const add = (value) => {
    const link = githubHttpsLink(value);
    if (link && !links.includes(link)) links.push(link);
  };
  add(`https://github.com/${options.repository}/pull/${options.itemNumber}`);
  add(options.commentUrl);
  add(options.workflowRunUrl);
  if (links.length > 20) throw new Error("proof link cap exceeded");
  return links;
}

function lifecycle(value) {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error("lifecycle field must be a string or null");
  const text = value.trim();
  if (!text || text.length > 80) throw new Error("lifecycle field is invalid");
  return text;
}

function shaOrNull(value, label) {
  if (value == null) return null;
  const parsed = sha(value);
  if (!parsed) throw new Error(`${label} is invalid`);
  return parsed;
}

function boundedCount(value) {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100_000) {
    throw new Error("findings count is invalid");
  }
  return value;
}

export function validateTelemetryRow(value, now) {
  const row = exactKeys(value, ROW_KEYS, "telemetry row");
  const repository = nonEmptyString(row.repository, 200)?.toLowerCase();
  const prNumber = Number(row.pr_number);
  const source = nonEmptyString(row.source, 300);
  if (
    !repository ||
    !REPOSITORY_PATTERN.test(repository) ||
    !Object.hasOwn(ADMITTED_REPOSITORIES, repository) ||
    !Number.isInteger(prNumber) ||
    prNumber < 1 ||
    !source
  ) {
    throw new Error("telemetry row identity is not an admitted DinkusKit review");
  }
  if (row.observed_at !== null && row.observed_at !== undefined && !isoDate(row.observed_at, now)) {
    throw new Error("telemetry row observed_at is malformed or in the future");
  }
  if (!Array.isArray(row.proof_links) || row.proof_links.length > 20) {
    throw new Error("telemetry row proof_links are invalid");
  }
  const proofLinks = row.proof_links.map((link) => {
    const trusted = githubHttpsLink(link);
    if (!trusted) throw new Error("telemetry row proof_links must be GitHub https URLs");
    return trusted;
  });
  const rating =
    row.rating == null ? null : CLAWSWEEPER_RANKS.includes(row.rating) ? row.rating : null;
  if (row.rating != null && rating == null) throw new Error("telemetry row rating is untrusted");
  const serialized = JSON.stringify(row);
  assertNoForbiddenText(serialized, "telemetry row");
  if (Object.keys(row).some((key) => SECRET_FIELD.test(key))) {
    throw new Error("telemetry row has an untrusted field");
  }
  return {
    repository,
    pr_number: prNumber,
    base_sha: shaOrNull(row.base_sha, "telemetry row base_sha"),
    head_sha: shaOrNull(row.head_sha, "telemetry row head_sha"),
    ci: lifecycle(row.ci) ?? "unknown",
    ci_conclusion: lifecycle(row.ci_conclusion),
    openclaw: lifecycle(row.openclaw) ?? "unknown",
    openclaw_conclusion: lifecycle(row.openclaw_conclusion),
    clawsweeper: lifecycle(row.clawsweeper) ?? "unknown",
    clawsweeper_conclusion: lifecycle(row.clawsweeper_conclusion),
    rating,
    proof_links: proofLinks,
    engine_sha: shaOrNull(row.engine_sha, "telemetry row engine_sha"),
    executor: nonEmptyString(row.executor, 200),
    findings_total: boundedCount(row.findings_total),
    findings_actionable: boundedCount(row.findings_actionable),
    observed_at: row.observed_at == null ? null : isoDate(row.observed_at, now),
    source,
  };
}

export function validateTelemetryEnvelope(value, now) {
  const feed = exactKeys(value, ENVELOPE_KEYS, "telemetry envelope");
  if (feed.schema_version !== SCHEMA_VERSION) throw new Error("telemetry schema is untrusted");
  if (feed.tenant !== TENANT) throw new Error("telemetry tenant is not dinkuskit");
  const generatedAt = isoDate(feed.generated_at, now);
  if (!generatedAt) throw new Error("telemetry generated_at is malformed or in the future");
  const lane = exactKeys(feed.lane, LANE_KEYS, "telemetry lane");
  if (
    lane.app_installation !== DINKUSKIT_LANE.app_installation ||
    lane.queue_namespace !== DINKUSKIT_LANE.queue_namespace ||
    lane.state_store !== DINKUSKIT_LANE.state_store ||
    lane.mutation_authority !== DINKUSKIT_LANE.mutation_authority
  ) {
    throw new Error("telemetry lane is not the DinkusKit native-canary writer");
  }
  if (!Array.isArray(feed.rows) || feed.rows.length > MAX_ROWS) {
    throw new Error("telemetry rows exceed the consumer cap");
  }
  const staleAfterSeconds = Number(feed.stale_after_seconds);
  if (
    !Number.isInteger(staleAfterSeconds) ||
    staleAfterSeconds < 30 ||
    staleAfterSeconds > 86_400
  ) {
    throw new Error("telemetry stale_after_seconds is outside the consumer bound");
  }
  return {
    schema_version: SCHEMA_VERSION,
    tenant: TENANT,
    generated_at: generatedAt,
    stale_after_seconds: staleAfterSeconds,
    lane: { ...DINKUSKIT_LANE },
    rows: feed.rows.map((row) => validateTelemetryRow(row, now)),
  };
}

function readExistingEnvelope(path, now) {
  try {
    lstatSync(path);
  } catch {
    return null;
  }
  const parsed = readRegularJson(path, "existing telemetry");
  return validateTelemetryEnvelope(parsed, now);
}

function assertSafeStateOutput(stateRoot, outputPath) {
  const root = resolve(stateRoot);
  const expected = resolve(root, TELEMETRY_RELATIVE_PATH);
  if (resolve(outputPath) !== expected) {
    throw new Error("telemetry output path is not the DinkusKit state record");
  }
  let current = expected;
  while (current !== root) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error("telemetry path must not traverse a symlink");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        current = dirname(current);
        continue;
      }
      throw error;
    }
    current = dirname(current);
  }
  try {
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("state root must be a regular directory");
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("state root is missing");
    }
    throw error;
  }
}

function rowKey(row) {
  return `${row.repository}#${row.pr_number}`;
}

export function buildCurrentTelemetryRow(options) {
  const now = options.now ?? Date.now();
  const repository = String(options.repository ?? "")
    .trim()
    .toLowerCase();
  const repositoryId = Number(options.repositoryId);
  const itemNumber = Number(options.itemNumber);
  const baseSha = sha(options.baseSha);
  const headSha = sha(options.headSha);
  const engineSha = sha(options.engineSha);
  if (!Object.hasOwn(ADMITTED_REPOSITORIES, repository)) {
    throw new Error("repository is not in the DinkusKit canary allowlist");
  }
  if (ADMITTED_REPOSITORIES[repository] !== repositoryId) {
    throw new Error("repository ID does not match the admitted DinkusKit tuple");
  }
  if (!Number.isInteger(itemNumber) || itemNumber < 1) {
    throw new Error("item number must be a positive integer");
  }
  if (!baseSha || !headSha || !engineSha) throw new Error("review SHAs are invalid");

  validateDinkuskitCanaryReport({
    reportPath: options.reportPath,
    repository,
    itemNumber,
    baseSha,
    headSha,
  });
  const { markdown, fields } = reportFrontmatter(options.reportPath);
  const labels = normalizedLabels(readOptionalRegularJson(options.labelsPath, "labels"));
  const comments = readOptionalRegularJson(options.commentsPath, "comments");
  const verdict = parseVerdict(markdown, itemNumber, headSha);
  const observedAt =
    isoDate(fields.get("reviewed_at"), now) ??
    isoDate(options.generatedAt, now) ??
    new Date(now).toISOString();
  const workflowRunUrl = options.workflowRunUrl ? githubHttpsLink(options.workflowRunUrl) : null;
  if (options.workflowRunUrl && !workflowRunUrl) {
    throw new Error("workflow run URL is not a trusted GitHub https URL");
  }

  return {
    repository,
    pr_number: itemNumber,
    base_sha: baseSha,
    head_sha: headSha,
    ci: "unknown",
    ci_conclusion: null,
    openclaw: "unknown",
    openclaw_conclusion: null,
    ...clawsweeperFromReport(String(fields.get("review_status") ?? "").toLowerCase(), verdict),
    rating: ratingFromInputs(fields, labels),
    proof_links: proofLinksFor({
      repository,
      itemNumber,
      commentUrl: commentProofLink(comments, itemNumber, fields),
      workflowRunUrl,
    }),
    engine_sha: engineSha,
    executor: EXECUTOR,
    findings_total: null,
    findings_actionable: null,
    observed_at: observedAt,
    source: SOURCE,
  };
}

export function buildDinkuskitReviewTelemetry(options) {
  const now = options.now ?? Date.now();
  const generatedAt = options.generatedAt
    ? isoDate(options.generatedAt, now)
    : new Date(now).toISOString();
  if (!generatedAt) throw new Error("telemetry generated_at is malformed or in the future");
  const staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
  if (
    !Number.isInteger(staleAfterSeconds) ||
    staleAfterSeconds < 30 ||
    staleAfterSeconds > 86_400
  ) {
    throw new Error("stale_after_seconds must be an integer from 30 to 86400");
  }
  const current = validateTelemetryRow(
    buildCurrentTelemetryRow({ ...options, generatedAt, now }),
    now,
  );
  const existing = options.existingEnvelope
    ? validateTelemetryEnvelope(options.existingEnvelope, now)
    : options.existingPath
      ? readExistingEnvelope(options.existingPath, now)
      : null;
  const rowsByKey = new Map();
  for (const row of existing?.rows ?? []) rowsByKey.set(rowKey(row), row);
  rowsByKey.set(rowKey(current), current);
  if (rowsByKey.size > MAX_ROWS) throw new Error("telemetry rows exceed the consumer cap");
  const rows = [...rowsByKey.values()].sort((left, right) => {
    const repo = left.repository.localeCompare(right.repository);
    return repo !== 0 ? repo : left.pr_number - right.pr_number;
  });
  return validateTelemetryEnvelope(
    {
      schema_version: SCHEMA_VERSION,
      tenant: TENANT,
      generated_at: generatedAt,
      stale_after_seconds: staleAfterSeconds,
      lane: { ...DINKUSKIT_LANE },
      rows,
    },
    now,
  );
}

export function writeDinkuskitReviewTelemetry(options) {
  const stateRoot = resolve(String(options.stateRoot ?? "").trim());
  const outputPath = join(stateRoot, ...TELEMETRY_RELATIVE_PATH.split("/"));
  assertSafeStateOutput(stateRoot, outputPath);
  const envelope = buildDinkuskitReviewTelemetry({
    ...options,
    existingPath: outputPath,
  });
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_BODY_BYTES) throw new Error("telemetry body exceeds the consumer size cap");
  assertNoForbiddenText(serialized, "telemetry envelope");
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o755 });
  writeFileSync(outputPath, serialized);
  regularFile(outputPath, "published telemetry", MAX_BODY_BYTES);
  return { envelope, outputPath, bytes };
}

export function parsePublisherArgs(argv) {
  const values = {
    stateRoot: null,
    reportPath: null,
    labelsPath: null,
    commentsPath: null,
    repository: null,
    repositoryId: null,
    itemNumber: null,
    baseSha: null,
    headSha: null,
    engineSha: null,
    generatedAt: null,
    workflowRunUrl: null,
    staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--help" || key === "-h") {
      values.help = true;
      index -= 1;
      continue;
    }
    if (!key?.startsWith("--") || value === undefined) throw new Error(USAGE.trim());
    switch (key) {
      case "--state-root":
        values.stateRoot = value;
        break;
      case "--report":
        values.reportPath = value;
        break;
      case "--labels":
        values.labelsPath = value;
        break;
      case "--comments":
        values.commentsPath = value;
        break;
      case "--repository":
        values.repository = value;
        break;
      case "--repository-id":
        values.repositoryId = value;
        break;
      case "--item-number":
        values.itemNumber = value;
        break;
      case "--base-sha":
        values.baseSha = value;
        break;
      case "--head-sha":
        values.headSha = value;
        break;
      case "--engine-sha":
        values.engineSha = value;
        break;
      case "--generated-at":
        values.generatedAt = value;
        break;
      case "--workflow-run-url":
        values.workflowRunUrl = value;
        break;
      case "--stale-after-seconds":
        values.staleAfterSeconds = Number(value);
        break;
      default:
        throw new Error(`unknown option: ${key}`);
    }
  }
  if (values.help) return values;
  for (const required of [
    "stateRoot",
    "reportPath",
    "repository",
    "repositoryId",
    "itemNumber",
    "baseSha",
    "headSha",
    "engineSha",
  ]) {
    if (!values[required]) throw new Error(`${required} is required`);
  }
  return values;
}

function assertCleanEnvironment() {
  for (const key of CREDENTIAL_ENV_KEYS) {
    if (process.env[key]) {
      throw new Error(
        "the telemetry publisher must not run with model or App credentials in the environment",
      );
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parsePublisherArgs(argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  assertCleanEnvironment();
  const result = writeDinkuskitReviewTelemetry({
    stateRoot: args.stateRoot,
    reportPath: args.reportPath,
    labelsPath: args.labelsPath,
    commentsPath: args.commentsPath,
    repository: args.repository,
    repositoryId: args.repositoryId,
    itemNumber: args.itemNumber,
    baseSha: args.baseSha,
    headSha: args.headSha,
    engineSha: args.engineSha,
    generatedAt: args.generatedAt,
    workflowRunUrl: args.workflowRunUrl,
    staleAfterSeconds: args.staleAfterSeconds,
  });
  process.stdout.write(
    `${JSON.stringify({
      path: TELEMETRY_RELATIVE_PATH,
      bytes: result.bytes,
      rows: result.envelope.rows.length,
      tenant: result.envelope.tenant,
    })}\n`,
  );
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "publish failed"}\n`);
    process.exitCode = 2;
  }
}
