import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const adapter = resolve("scripts/run-copilot-codex-adapter.mjs");
const nativeSchema = readFileSync("schema/clawsweeper-decision.schema.json", "utf8");

type Fixture = ReturnType<typeof createFixture>;

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-copilot-adapter-"));
  const target = join(root, "target");
  const artifacts = join(root, "artifacts");
  const codexArtifacts = join(artifacts, "codex");
  const scratch = join(codexArtifacts, "proof-scratch", "7");
  const schemas = join(root, "schema");
  const home = join(root, "home");
  const copilotHome = join(home, ".copilot");
  const fakeCopilot = join(root, "fake-copilot.mjs");
  const capture = join(root, "capture.json");
  for (const path of [target, scratch, schemas, copilotHome]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(schemas, "clawsweeper-decision.schema.json"), nativeSchema);
  writeFileSync(
    fakeCopilot,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const promptIndex = args.indexOf("-p");
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : null;
const requestPath = prompt?.split("\\n")[1] ?? null;
writeFileSync(process.env.FAKE_CAPTURE, JSON.stringify({
  args,
  prompt,
  requestPath,
  request: requestPath ? readFileSync(requestPath, "utf8") : null,
  home: process.env.COPILOT_HOME,
}));
if (process.env.FAKE_FAIL === "1") {
  process.stderr.write(
    process.env.FAKE_ERROR ??
      "transport failed COPILOT_GITHUB_TOKEN=" + process.env.COPILOT_GITHUB_TOKEN,
  );
  process.exit(7);
}
process.stdout.write(process.env.FAKE_RESPONSE);
`,
  );
  chmodSync(fakeCopilot, 0o755);
  return {
    root,
    target,
    artifacts,
    scratch,
    schemas,
    home,
    copilotHome,
    fakeCopilot,
    capture,
    failureDiagnostic: join(codexArtifacts, "copilot-failure.json"),
    output: join(codexArtifacts, "7.json"),
    schema: join(schemas, "clawsweeper-decision.schema.json"),
  };
}

function codexArgs(fixture: Fixture): string[] {
  return [
    "exec",
    "--model",
    "gpt-5.6-terra",
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    'service_tier="default"',
    "-c",
    'approval_policy="never"',
    "-C",
    fixture.target,
    "--output-schema",
    fixture.schema,
    "--output-last-message",
    fixture.output,
    "--json",
    "--sandbox",
    "read-only",
    "--add-dir",
    fixture.scratch,
    "-",
  ];
}

function runAdapter(
  fixture: Fixture,
  options: {
    args?: string[];
    error?: string;
    fail?: boolean;
    input?: string;
    response?: string;
  } = {},
) {
  return spawnSync(process.execPath, [adapter, ...(options.args ?? codexArgs(fixture))], {
    cwd: fixture.target,
    env: {
      ...process.env,
      HOME: fixture.home,
      COPILOT_GITHUB_TOKEN: "github_pat_test_abcdefghijklmnopqrstuvwxyz123456",
      CLAWSWEEPER_REAL_COPILOT: fixture.fakeCopilot,
      CLAWSWEEPER_ADAPTER_TARGET_DIR: fixture.target,
      CLAWSWEEPER_ADAPTER_ARTIFACT_DIR: fixture.artifacts,
      CLAWSWEEPER_ADAPTER_SCHEMA_DIR: fixture.schemas,
      CLAWSWEEPER_PROOF_SCRATCH_DIR: fixture.scratch,
      CLAWSWEEPER_COPILOT_HOME: fixture.copilotHome,
      CLAWSWEEPER_COPILOT_MODEL: "gpt-5.6-terra",
      CLAWSWEEPER_COPILOT_EFFORT: "high",
      FAKE_CAPTURE: fixture.capture,
      FAKE_ERROR: options.error,
      FAKE_FAIL: options.fail ? "1" : "0",
      FAKE_RESPONSE: options.response ?? '{"decision":"keep_open"}',
    },
    input: options.input ?? "Review the admitted pull request.",
    encoding: "utf8",
  });
}

test("Copilot adapter maps only the admitted Terra high read-only invocation", () => {
  const fixture = createFixture();
  try {
    const result = runAdapter(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(fixture.output, "utf8")), {
      decision: "keep_open",
    });
    const capture = JSON.parse(readFileSync(fixture.capture, "utf8")) as {
      args: string[];
      prompt: string;
      requestPath: string;
      request: string;
      home: string;
    };
    assert.ok(capture.args.includes("--model=gpt-5.6-terra"));
    assert.ok(capture.args.includes("--effort=high"));
    assert.ok(capture.args.includes("--available-tools=view,glob,grep"));
    assert.ok(capture.args.includes("--allow-tool=view,glob,grep"));
    assert.ok(capture.args.includes("--disable-builtin-mcps"));
    assert.ok(capture.args.includes("--disallow-temp-dir"));
    assert.ok(capture.args.includes("--secret-env-vars=COPILOT_GITHUB_TOKEN"));
    assert.ok(capture.args.includes("--max-ai-credits=50"));
    assert.ok(!capture.args.some((arg) => /fast/i.test(arg)));
    assert.deepEqual(
      capture.args.filter((arg) => arg.startsWith("--allow-tool")),
      ["--allow-tool=view,glob,grep"],
    );
    assert.match(capture.prompt, /complete request in this admitted read-only file/);
    assert.ok(Buffer.byteLength(capture.prompt) < 4_096);
    assert.match(capture.request, /Review the admitted pull request/);
    assert.match(capture.request, /Required machine-readable response/);
    assert.match(capture.request, /"additionalProperties": false/);
    assert.equal(existsSync(capture.requestPath), false);
    assert.equal(capture.home, realpathSync(fixture.copilotHome));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Copilot adapter keeps oversized native requests out of the process argument vector", () => {
  const fixture = createFixture();
  try {
    const oversizedPrompt = `Review this exact bounded input:\n${"x".repeat(300_000)}`;
    const result = runAdapter(fixture, { input: oversizedPrompt });
    assert.equal(result.status, 0, result.stderr);
    const capture = JSON.parse(readFileSync(fixture.capture, "utf8")) as {
      args: string[];
      prompt: string;
      requestPath: string;
      request: string;
    };
    assert.ok(Buffer.byteLength(capture.prompt) < 4_096);
    assert.ok(Math.max(...capture.args.map((arg) => Buffer.byteLength(arg))) < 4_096);
    assert.match(capture.request, /Review this exact bounded input/);
    assert.ok(Buffer.byteLength(capture.request) > 300_000);
    assert.match(capture.request, /Required machine-readable response/);
    assert.equal(existsSync(capture.requestPath), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Copilot adapter accepts one optional JSON fence and normalizes the output", () => {
  const fixture = createFixture();
  try {
    const result = runAdapter(fixture, {
      response: '```json\n{"decision":"keep_open"}\n```\n',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(fixture.output, "utf8"), '{"decision":"keep_open"}\n');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Copilot adapter classifies invalid model output without preserving it", () => {
  const fixture = createFixture();
  try {
    const result = runAdapter(fixture, { response: "not-json private model output" });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(readFileSync(fixture.failureDiagnostic, "utf8")), {
      category: "response_contract",
      exit_status: 0,
      kind: "clawsweeper_copilot_failure",
    });
    assert.doesNotMatch(readFileSync(fixture.failureDiagnostic, "utf8"), /private model output/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Copilot adapter rejects any expansion of the Codex protocol before model execution", () => {
  const fixture = createFixture();
  try {
    const args = codexArgs(fixture);
    args.splice(args.length - 1, 0, "--dangerously-bypass-approvals-and-sandbox");
    const result = runAdapter(fixture, { args });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unsupported Codex argument/);
    assert.throws(() => readFileSync(fixture.capture));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Copilot adapter redacts the credential from model failures", () => {
  const fixture = createFixture();
  try {
    const result = runAdapter(fixture, { fail: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /COPILOT_GITHUB_TOKEN=\[REDACTED\]/);
    assert.doesNotMatch(result.stderr, /github_pat_test_abcdefghijklmnopqrstuvwxyz123456/);
    assert.deepEqual(JSON.parse(readFileSync(fixture.failureDiagnostic, "utf8")), {
      category: "unclassified",
      exit_status: 7,
      kind: "clawsweeper_copilot_failure",
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Copilot adapter records only a bounded failure category", () => {
  const cases = [
    [
      "Authentication token found but could not be validated (401): Bad credentials",
      "authentication",
    ],
    ["Access denied by policy settings: Copilot subscription is unavailable", "copilot_access"],
    ["The selected model is unavailable for this account", "model_access"],
    ["Unknown tool supplied to --available-tools", "cli_contract"],
    ["Request failed with ETIMEDOUT", "network"],
  ] as const;

  for (const [error, category] of cases) {
    const fixture = createFixture();
    try {
      const result = runAdapter(fixture, { error, fail: true });
      assert.equal(result.status, 1);
      assert.deepEqual(JSON.parse(readFileSync(fixture.failureDiagnostic, "utf8")), {
        category,
        exit_status: 7,
        kind: "clawsweeper_copilot_failure",
      });
      assert.doesNotMatch(readFileSync(fixture.failureDiagnostic, "utf8"), new RegExp(error, "i"));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});
