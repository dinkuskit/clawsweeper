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
const decisionMcp = resolve("scripts/run-copilot-decision-mcp.mjs");
const nativeSchema = readFileSync("schema/clawsweeper-decision.schema.json", "utf8");

type Fixture = ReturnType<typeof createFixture>;

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-copilot-adapter-"));
  const target = join(root, "target");
  const artifacts = join(root, "artifacts");
  const codexArtifacts = join(artifacts, "codex");
  const scratch = join(codexArtifacts, "proof-scratch", "7");
  const schemas = join(root, "schema");
  const dist = join(root, "dist");
  const validator = join(dist, "clawsweeper.js");
  const home = join(root, "home");
  const copilotHome = join(home, ".copilot");
  const fakeCopilot = join(root, "fake-copilot.mjs");
  const capture = join(root, "capture.json");
  for (const path of [target, scratch, schemas, dist, copilotHome]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(schemas, "clawsweeper-decision.schema.json"), nativeSchema);
  writeFileSync(
    validator,
    `export function parseDecision(value) {
  if (value?.decision !== "keep_open") throw new Error("decision.decision has invalid value");
  return value;
}
`,
  );
  writeFileSync(
    fakeCopilot,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const promptIndex = args.indexOf("-p");
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : null;
const requestPath = prompt?.split("\\n")[1] ?? null;
const mcpConfigArgument = args.find((arg) => arg.startsWith("--additional-mcp-config="));
const mcpConfig = mcpConfigArgument
  ? JSON.parse(mcpConfigArgument.slice("--additional-mcp-config=".length))
  : null;
const responsePath = mcpConfig?.mcpServers?.ClawSweeper?.args?.[2] ?? null;
writeFileSync(process.env.FAKE_CAPTURE, JSON.stringify({
  args,
  prompt,
  requestPath,
  responsePath,
  mcpConfig,
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
if (process.env.FAKE_WRITE_RESPONSE === "1" && responsePath) {
  writeFileSync(responsePath, process.env.FAKE_FILE_RESPONSE);
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
    adapterStatus: join(codexArtifacts, "copilot-adapter-status.json"),
    failureDiagnostic: join(codexArtifacts, "copilot-failure.json"),
    output: join(codexArtifacts, "7.json"),
    schema: join(schemas, "clawsweeper-decision.schema.json"),
    validator,
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
    fileResponse?: string | null;
    response?: string;
  } = {},
) {
  const fileResponse =
    options.fileResponse === undefined ? '{"decision":"keep_open"}' : options.fileResponse;
  return spawnSync(process.execPath, [adapter, ...(options.args ?? codexArgs(fixture))], {
    cwd: fixture.target,
    env: {
      ...process.env,
      HOME: fixture.home,
      COPILOT_GITHUB_TOKEN: "github_pat_test_abcdefghijklmnopqrstuvwxyz123456",
      CLAWSWEEPER_REAL_COPILOT: fixture.fakeCopilot,
      CLAWSWEEPER_COPILOT_DECISION_MCP: decisionMcp,
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
      FAKE_FILE_RESPONSE: fileResponse ?? "",
      FAKE_RESPONSE: options.response ?? '{"decision":"keep_open"}',
      FAKE_WRITE_RESPONSE: fileResponse === null ? "0" : "1",
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
    assert.deepEqual(JSON.parse(readFileSync(fixture.adapterStatus, "utf8")), {
      kind: "clawsweeper_copilot_adapter",
      status: "accepted",
    });
    const capture = JSON.parse(readFileSync(fixture.capture, "utf8")) as {
      args: string[];
      prompt: string;
      requestPath: string;
      responsePath: string;
      mcpConfig: {
        mcpServers: {
          ClawSweeper: {
            type: string;
            command: string;
            args: string[];
            env: Record<string, never>;
            tools: string[];
          };
        };
      };
      request: string;
      home: string;
    };
    assert.ok(capture.args.includes("--model=gpt-5.6-terra"));
    assert.ok(capture.args.includes("--effort=high"));
    assert.ok(capture.args.includes("--available-tools=view,glob,grep,ClawSweeper-submit_review"));
    assert.ok(capture.args.includes("--allow-tool=view,glob,grep"));
    assert.ok(capture.args.includes("--allow-tool=ClawSweeper(submit_review)"));
    assert.ok(capture.args.includes("--disable-builtin-mcps"));
    assert.ok(capture.args.includes("--disallow-temp-dir"));
    assert.ok(capture.args.includes("--secret-env-vars=COPILOT_GITHUB_TOKEN"));
    assert.ok(capture.args.includes("--max-ai-credits=50"));
    assert.ok(!capture.args.some((arg) => /fast/i.test(arg)));
    assert.deepEqual(
      capture.args.filter((arg) => arg.startsWith("--allow-tool")),
      ["--allow-tool=view,glob,grep", "--allow-tool=ClawSweeper(submit_review)"],
    );
    assert.deepEqual(capture.mcpConfig.mcpServers.ClawSweeper, {
      type: "local",
      command: process.execPath,
      args: [
        decisionMcp,
        realpathSync(fixture.schema),
        capture.responsePath,
        realpathSync(fixture.validator),
      ],
      env: {},
      tools: ["submit_review"],
    });
    assert.match(capture.prompt, /complete request in this admitted read-only file/);
    assert.ok(Buffer.byteLength(capture.prompt) < 4_096);
    assert.match(capture.request, /Review the admitted pull request/);
    assert.match(capture.request, /Required machine-readable response/);
    assert.match(capture.request, /ClawSweeper submit_review tool/);
    assert.match(capture.request, /correct it and retry/);
    assert.equal(existsSync(capture.requestPath), false);
    assert.equal(existsSync(capture.responsePath), false);
    assert.equal(capture.home, realpathSync(fixture.copilotHome));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Copilot adapter prefers the exact path-scoped response file over chat prose", () => {
  const fixture = createFixture();
  try {
    const result = runAdapter(fixture, {
      fileResponse: '{"decision":"keep_open"}',
      response: "The review is complete.",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(fixture.output, "utf8"), '{"decision":"keep_open"}\n');
    const capture = JSON.parse(readFileSync(fixture.capture, "utf8")) as {
      responsePath: string;
    };
    assert.equal(existsSync(capture.responsePath), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("decision MCP exposes the native schema and records one bounded tool submission", () => {
  const fixture = createFixture();
  const responsePath = join(fixture.scratch, ".clawsweeper-copilot-response.json");
  try {
    const result = spawnSync(
      process.execPath,
      [decisionMcp, fixture.schema, responsePath, fixture.validator],
      {
        input: `${[
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18" },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "submit_review", arguments: { decision: "invalid" } },
          },
          {
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: { name: "submit_review", arguments: { decision: "keep_open" } },
          },
        ]
          .map((message) => JSON.stringify(message))
          .join("\n")}\n`,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const messages = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as Array<{
      id: number;
      result: {
        tools?: Array<{ name: string; inputSchema: unknown }>;
        content?: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      error?: { code: number; message: string };
    }>;
    assert.deepEqual(
      messages.map((message) => message.id),
      [1, 2, 3, 4],
    );
    assert.equal(messages[1]?.result.tools?.[0]?.name, "submit_review");
    assert.deepEqual(messages[1]?.result.tools?.[0]?.inputSchema, JSON.parse(nativeSchema));
    assert.equal(messages[2]?.result.isError, true);
    assert.match(
      messages[2]?.result.content?.[0]?.text ?? "",
      /decision\.decision has invalid value/,
    );
    assert.deepEqual(messages[3]?.result.content, [
      { type: "text", text: "Native ClawSweeper review accepted." },
    ]);
    assert.equal(readFileSync(responsePath, "utf8"), '{"decision":"keep_open"}\n');
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

test("Copilot adapter rejects stdout JSON when the native tool was not accepted", () => {
  const fixture = createFixture();
  try {
    const result = runAdapter(fixture, {
      fileResponse: null,
      response: 'Completed the review.\n```json\n{"decision":"keep_open"}\n```\n',
    });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(readFileSync(fixture.failureDiagnostic, "utf8")), {
      category: "response_contract",
      exit_status: 0,
      kind: "clawsweeper_copilot_failure",
    });
    assert.equal(existsSync(fixture.output), false);
    assert.equal(existsSync(fixture.adapterStatus), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Copilot adapter rejects ambiguous stdout without preserving it", () => {
  const rejectedFixture = createFixture();
  try {
    const result = runAdapter(rejectedFixture, {
      fileResponse: null,
      response: '{"decision":"keep_open"}\n{"decision":"close"}',
    });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(readFileSync(rejectedFixture.failureDiagnostic, "utf8")), {
      category: "response_contract",
      exit_status: 0,
      kind: "clawsweeper_copilot_failure",
    });
    assert.equal(existsSync(rejectedFixture.output), false);
    assert.equal(existsSync(rejectedFixture.adapterStatus), false);
  } finally {
    rmSync(rejectedFixture.root, { recursive: true, force: true });
  }
});

test("Copilot adapter classifies invalid model output without preserving it", () => {
  const fixture = createFixture();
  try {
    const result = runAdapter(fixture, {
      fileResponse: null,
      response: "not-json private model output",
    });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(readFileSync(fixture.failureDiagnostic, "utf8")), {
      category: "response_contract",
      exit_status: 0,
      kind: "clawsweeper_copilot_failure",
    });
    assert.doesNotMatch(readFileSync(fixture.failureDiagnostic, "utf8"), /private model output/);
    assert.equal(existsSync(fixture.adapterStatus), false);
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
