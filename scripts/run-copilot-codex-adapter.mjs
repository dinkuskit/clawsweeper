#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  constants as fsConstants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const MAX_PROMPT_BYTES = 1_500_000;
const MAX_SCHEMA_BYTES = 200_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_ERROR_BYTES = 8_000;
const MAX_BOOTSTRAP_PROMPT_BYTES = 4_096;
const EXPECTED_MODEL = "gpt-5.6-terra";
const EXPECTED_EFFORT = "high";

function fail(message, status = 2) {
  process.stderr.write(`ClawSweeper Copilot adapter: ${sanitize(message)}\n`);
  process.exit(status);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function absoluteExistingPath(name, expectedType) {
  const configured = requiredEnv(name);
  if (!isAbsolute(configured)) fail(`${name} must be absolute`);
  let canonical;
  try {
    canonical = realpathSync(configured);
  } catch {
    fail(`${name} does not resolve to an existing path`);
  }
  const stats = statSync(canonical);
  if (expectedType === "file" && !stats.isFile()) fail(`${name} must resolve to a file`);
  if (expectedType === "directory" && !stats.isDirectory()) {
    fail(`${name} must resolve to a directory`);
  }
  if (expectedType === "file") {
    try {
      const fd = openSync(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      closeSync(fd);
    } catch {
      fail(`${name} must resolve to a readable non-symlink file`);
    }
  }
  return canonical;
}

function pathWithin(root, candidate, label) {
  if (!isAbsolute(candidate)) fail(`${label} must be absolute`);
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const relation = relative(normalizedRoot, normalizedCandidate);
  if (
    !relation ||
    relation === ".." ||
    relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relation)
  ) {
    fail(`${label} must be a child of its admitted root`);
  }
  return normalizedCandidate;
}

function readBoundedStdin() {
  const chunks = [];
  let bytes = 0;
  const buffer = readFileSync(0);
  bytes += buffer.length;
  if (bytes > MAX_PROMPT_BYTES) fail("the review prompt exceeded the bounded input contract");
  chunks.push(buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parseObjectCandidate(value) {
  try {
    const parsed = JSON.parse(value.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sanitize(value) {
  let safe = String(value ?? "");
  const token = process.env.COPILOT_GITHUB_TOKEN;
  if (token) safe = safe.replaceAll(token, "[REDACTED_GITHUB_TOKEN]");
  return safe
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN)=([^\s"']+)/g, "$1=[REDACTED]")
    .replace(
      /"((?:COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN))"\s*:\s*"[^"]*"/g,
      '"$1":"[REDACTED]"',
    );
}

function classifyCopilotFailure(value) {
  const message = sanitize(value);
  if (
    /authentication token found but could not be validated|failed to fetch PAT user login|failed to authenticate|unable to verify[^\n]*credentials|bad credentials|\b401\b|token (?:is )?(?:invalid|expired|revoked)|invalid[^\n]*token/i.test(
      message,
    )
  ) {
    return "authentication";
  }
  if (
    /access denied by policy|copilot[^\n]*(?:license|subscription|not enabled|not available)|(?:license|subscription)[^\n]*copilot|copilot requests[^\n]*permission/i.test(
      message,
    )
  ) {
    return "copilot_access";
  }
  if (
    /model[^\n]*(?:unavailable|not available|not found|does not exist|unsupported|access denied|not accessible|do not have access)|(?:unknown|invalid|unsupported)[^\n]*model|no access to (?:the )?model/i.test(
      message,
    )
  ) {
    return "model_access";
  }
  if (
    /(?:unknown|invalid|unsupported)[^\n]*(?:option|argument|tool)|reasoning effort[^\n]*(?:unsupported|invalid)|non-interactive[^\n]*(?:allow-all-tools|permission)/i.test(
      message,
    )
  ) {
    return "cli_contract";
  }
  if (
    /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)\b|network|fetch failed|socket hang up/i.test(
      message,
    )
  ) {
    return "network";
  }
  return "unclassified";
}

function recordCopilotFailure(value, status, category = classifyCopilotFailure(value)) {
  const diagnosticPath = join(artifactRoot, "codex", "copilot-failure.json");
  try {
    const fd = openSync(
      diagnosticPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(
      fd,
      `${JSON.stringify({
        category,
        exit_status: Number.isInteger(status) ? status : null,
        kind: "clawsweeper_copilot_failure",
      })}\n`,
      "utf8",
    );
    closeSync(fd);
  } catch {
    // The primary failure remains authoritative when a bounded diagnostic cannot be recorded.
  }
}

function parseCodexInvocation(args) {
  if (args.shift() !== "exec") fail("only the Codex exec protocol is admitted");
  const parsed = { configs: [], terminalStdin: false };
  while (args.length > 0) {
    const option = args.shift();
    if (option === "-") {
      if (args.length > 0 || parsed.terminalStdin) fail("stdin must be the final unique argument");
      parsed.terminalStdin = true;
      continue;
    }
    if (option === "--json") {
      if (parsed.json) fail("--json may be specified only once");
      parsed.json = true;
      continue;
    }
    const supported = new Map([
      ["--model", "model"],
      ["-c", "config"],
      ["-C", "cwd"],
      ["--output-schema", "schema"],
      ["--output-last-message", "output"],
      ["--sandbox", "sandbox"],
      ["--add-dir", "addDir"],
    ]);
    const field = supported.get(option);
    if (!field) fail(`unsupported Codex argument: ${option}`);
    const value = args.shift();
    if (!value) fail(`${option} requires a value`);
    if (field === "config") parsed.configs.push(value);
    else {
      if (parsed[field]) fail(`${option} may be specified only once`);
      parsed[field] = value;
    }
  }
  if (!parsed.json || !parsed.terminalStdin)
    fail("the structured stdin Codex protocol is required");
  for (const field of ["model", "cwd", "schema", "output", "sandbox", "addDir"]) {
    if (!parsed[field]) fail(`the Codex ${field} field is required`);
  }
  return parsed;
}

const copilotBin = absoluteExistingPath("CLAWSWEEPER_REAL_COPILOT", "file");
const decisionMcpBin = absoluteExistingPath("CLAWSWEEPER_COPILOT_DECISION_MCP", "file");
const targetRoot = absoluteExistingPath("CLAWSWEEPER_ADAPTER_TARGET_DIR", "directory");
const artifactRoot = absoluteExistingPath("CLAWSWEEPER_ADAPTER_ARTIFACT_DIR", "directory");
const schemaRoot = absoluteExistingPath("CLAWSWEEPER_ADAPTER_SCHEMA_DIR", "directory");
const scratchRoot = absoluteExistingPath("CLAWSWEEPER_PROOF_SCRATCH_DIR", "directory");
const copilotHome = absoluteExistingPath("CLAWSWEEPER_COPILOT_HOME", "directory");
const token = requiredEnv("COPILOT_GITHUB_TOKEN");
const configuredModel = requiredEnv("CLAWSWEEPER_COPILOT_MODEL");
const configuredEffort = requiredEnv("CLAWSWEEPER_COPILOT_EFFORT");
if (configuredModel !== EXPECTED_MODEL) fail("the configured Copilot model is not admitted");
if (configuredEffort !== EXPECTED_EFFORT) fail("the configured Copilot effort is not admitted");
if (token.length < 20) fail("COPILOT_GITHUB_TOKEN did not satisfy the credential shape check");

const invocation = parseCodexInvocation(process.argv.slice(2));
if (invocation.model !== configuredModel)
  fail("the Codex model did not match the admitted Copilot model");
if (invocation.sandbox !== "read-only") fail("only the read-only Codex sandbox is admitted");
if (realpathSync(invocation.cwd) !== targetRoot || realpathSync(process.cwd()) !== targetRoot) {
  fail("the Codex working directory did not match the admitted target checkout");
}
if (realpathSync(invocation.addDir) !== scratchRoot) {
  fail("the Codex add-dir did not match the admitted proof scratch directory");
}
const expectedConfigs = new Set([
  `model_reasoning_effort="${configuredEffort}"`,
  'service_tier="default"',
  'approval_policy="never"',
]);
if (
  invocation.configs.length !== expectedConfigs.size ||
  invocation.configs.some((config) => !expectedConfigs.delete(config)) ||
  expectedConfigs.size !== 0
) {
  fail("the Codex configuration did not match the admitted high-effort, non-fast contract");
}

const schemaPath = pathWithin(schemaRoot, realpathSync(invocation.schema), "the output schema");
if (schemaPath !== join(schemaRoot, "clawsweeper-decision.schema.json")) {
  fail("only the native ClawSweeper decision schema is admitted");
}
const engineRoot = realpathSync(dirname(schemaRoot));
const validatorPath = pathWithin(
  engineRoot,
  realpathSync(join(engineRoot, "dist", "clawsweeper.js")),
  "the native decision validator",
);
if (validatorPath !== join(engineRoot, "dist", "clawsweeper.js")) {
  fail("only the pinned native ClawSweeper decision validator is admitted");
}
const outputPath = pathWithin(
  artifactRoot,
  join(realpathSync(dirname(invocation.output)), basename(invocation.output)),
  "the output file",
);
if (realpathSync(dirname(outputPath)) === artifactRoot) {
  fail("the output file must remain inside the native Codex artifact subtree");
}

const prompt = readBoundedStdin();
if (!prompt.trim()) fail("the review prompt was empty");
const schema = readFileSync(schemaPath, "utf8");
if (Buffer.byteLength(schema) > MAX_SCHEMA_BYTES) fail("the decision schema exceeded its bound");
const combinedPrompt = `${prompt}\n\n## Required machine-readable response\nAfter completing the review, call the ClawSweeper submit_review tool. Its arguments must satisfy the native decision schema and semantic invariants enforced by that tool. If validation rejects an invariant, correct it and retry. An accepted tool call is the only accepted response.\n`;

// Linux rejects any single argv entry larger than MAX_ARG_STRLEN (normally 128 KiB),
// even when the aggregate ARG_MAX limit is larger. A native ClawSweeper prompt plus
// its decision schema routinely crosses that boundary. Keep the complete bounded
// request in the already-admitted read-only scratch tree and pass only a small,
// deterministic bootstrap prompt to Copilot.
const requestPath = join(scratchRoot, ".clawsweeper-copilot-request.md");
const responsePath = join(scratchRoot, ".clawsweeper-copilot-response.json");
if (existsSync(responsePath)) {
  recordCopilotFailure("the bounded Copilot response path already existed", null, "execution");
  fail("the bounded Copilot response path already existed", 1);
}
try {
  const fd = openSync(
    requestPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o400,
  );
  writeFileSync(fd, combinedPrompt, "utf8");
  closeSync(fd);
} catch {
  recordCopilotFailure("the bounded Copilot request file could not be created", null, "execution");
  fail("the bounded Copilot request file could not be created", 1);
}
const bootstrapPrompt = [
  "Perform the ClawSweeper review from the complete request in this admitted read-only file:",
  requestPath,
  "Use the view tool repeatedly until you have read the entire file, including the response requirements.",
  "Follow that request exactly, then call the ClawSweeper submit_review tool.",
  "If native validation rejects an invariant, correct it and retry the tool call.",
  "Do not finish until that tool confirms the native review was accepted.",
].join("\n");
if (Buffer.byteLength(bootstrapPrompt) > MAX_BOOTSTRAP_PROMPT_BYTES) {
  try {
    unlinkSync(requestPath);
  } catch {
    // The primary bounded-prompt failure remains authoritative.
  }
  recordCopilotFailure("the Copilot bootstrap prompt exceeded its bound", null, "execution");
  fail("the Copilot bootstrap prompt exceeded its bound", 1);
}

const additionalMcpConfig = JSON.stringify({
  mcpServers: {
    ClawSweeper: {
      type: "local",
      command: process.execPath,
      args: [decisionMcpBin, schemaPath, responsePath, validatorPath],
      env: {},
      tools: ["submit_review"],
    },
  },
});
const copilotArgs = [
  `--model=${configuredModel}`,
  `--effort=${configuredEffort}`,
  "--no-ask-user",
  "--no-auto-update",
  "--no-bash-env",
  "--no-color",
  "--no-custom-instructions",
  "--no-experimental",
  "--no-remote",
  "--no-remote-export",
  "--disable-builtin-mcps",
  "--disallow-temp-dir",
  `--additional-mcp-config=${additionalMcpConfig}`,
  "--available-tools=view,glob,grep,ClawSweeper-submit_review",
  "--allow-tool=view,glob,grep",
  "--allow-tool=ClawSweeper(submit_review)",
  "--secret-env-vars=COPILOT_GITHUB_TOKEN",
  "--max-ai-credits=50",
  "--stream=off",
  "--silent",
  "-C",
  targetRoot,
  "--add-dir",
  scratchRoot,
  "-p",
  bootstrapPrompt,
];
let result;
try {
  result = spawnSync(copilotBin, copilotArgs, {
    cwd: targetRoot,
    env: {
      ...process.env,
      HOME: requiredEnv("HOME"),
      COPILOT_HOME: copilotHome,
      COPILOT_GITHUB_TOKEN: token,
      CI: "true",
      NO_COLOR: "1",
    },
    encoding: "utf8",
    maxBuffer: MAX_RESPONSE_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
} finally {
  try {
    unlinkSync(requestPath);
  } catch {
    // The native review result remains authoritative; the containing artifact tree
    // is revoked and removed by the workflow even if this best-effort cleanup fails.
  }
}
if (result.error) {
  recordCopilotFailure(result.error.message, null, "execution");
  fail(`Copilot CLI failed to execute: ${result.error.message}`, 1);
}
if (Buffer.byteLength(result.stdout ?? "") > MAX_RESPONSE_BYTES) {
  recordCopilotFailure(
    "Copilot CLI exceeded the bounded response contract",
    0,
    "response_contract",
  );
  fail("Copilot CLI exceeded the bounded response contract", 1);
}
if (!existsSync(responsePath)) {
  if (result.status !== 0) {
    recordCopilotFailure(result.stderr, result.status);
    const detail = sanitize(result.stderr).slice(-MAX_ERROR_BYTES).trim();
    fail(`Copilot CLI exited with status ${result.status}${detail ? `: ${detail}` : ""}`, 1);
  }
  recordCopilotFailure("Copilot CLI did not submit a native review", 0, "response_contract");
  fail("Copilot CLI did not submit through the native ClawSweeper tool", 1);
}
let responseFd;
let response;
try {
  responseFd = openSync(responsePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const responseStats = fstatSync(responseFd);
  if (!responseStats.isFile() || responseStats.size > MAX_RESPONSE_BYTES) {
    throw new Error("invalid bounded response file");
  }
  response = readFileSync(responseFd, "utf8");
} catch {
  try {
    unlinkSync(responsePath);
  } catch {
    // The bounded response failure remains authoritative.
  }
  recordCopilotFailure(
    "Copilot CLI wrote an invalid bounded response file",
    0,
    "response_contract",
  );
  fail("Copilot CLI wrote an invalid bounded response file", 1);
} finally {
  if (responseFd !== undefined) closeSync(responseFd);
}
try {
  unlinkSync(responsePath);
} catch {
  // The parsed response remains authoritative; the workflow revokes the scratch tree.
}
const decision = parseObjectCandidate(response);
if (!decision) {
  recordCopilotFailure("Copilot CLI submitted invalid JSON", 0, "response_contract");
  fail("Copilot CLI did not submit one exact JSON object", 1);
}
try {
  const fd = openSync(
    outputPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  writeFileSync(fd, `${JSON.stringify(decision)}\n`, "utf8");
  closeSync(fd);
} catch {
  recordCopilotFailure("the bounded native output file could not be created", 0, "execution");
  fail("the bounded native output file could not be created", 1);
}
