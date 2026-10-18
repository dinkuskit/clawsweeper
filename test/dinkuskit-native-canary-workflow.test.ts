import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";

const source = readFileSync(".github/workflows/dinkuskit-native-canary.yml", "utf8");
const workflow = parse(source);
const step = workflow.jobs.relay.steps[0];
const python = step.run
  .split("<<'PYREQUEST'")[1]
  .split("\n")
  .slice(1)
  .join("\n")
  .split("\nPYREQUEST")[0];
const inputs = {
  RELAY_REPOSITORY: "example/private-review-receiver",
  TARGET_REPOSITORY: "blocks",
  TARGET_REPOSITORY_ID: "1306882611",
  PR_NUMBER: "47",
  REQUESTED_BASE: "a".repeat(40),
  REQUESTED_HEAD: "b".repeat(40),
  PUBLISH: "true",
  ORIGIN_REPOSITORY: "dinkuskit/blocks",
  ORIGIN_RUN_ID: "12345",
  ORIGIN_RUN_ATTEMPT: "1",
  COMMENT_ID: "",
};

test("native review workflow relays events without a hosted model", () => {
  assert.deepEqual(Object.keys(workflow.jobs), ["relay"]);
  assert.equal(workflow.jobs.relay["runs-on"], "ubuntu-24.04");
  assert.equal(workflow.jobs.relay.if, "vars.CLAWSWEEPER_SPARK_ENABLED == 'true'");
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.on.workflow_call.secrets), [
    "CLAWSWEEPER_DISPATCH_TOKEN",
    "CLAWSWEEPER_DO_QUEUE_SECRET",
  ]);
  assert.equal(workflow.on.workflow_call.secrets.CLAWSWEEPER_DO_QUEUE_SECRET.required, false);
  assert.equal(workflow.on.workflow_call.inputs.queue_mode.default, "off");
  assert.doesNotMatch(
    source,
    /COPILOT|OPENAI_API_KEY|actions\/checkout|setup-codex|self-hosted|npm install|pnpm install/,
  );
  assert.equal(spawnSync("bash", ["-n"], { input: step.run }).status, 0);
});

test("relay emits a bounded source-bound request, including proposal-only mode", () => {
  for (const publish of ["true", "false"]) {
    const result = spawnSync("python3", ["-I", "-"], {
      input: python,
      encoding: "utf8",
      env: { ...process.env, ...inputs, PUBLISH: publish },
    });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.event_type, "clawsweeper_native_pr");
    assert.equal(body.client_payload.target_repo, "dinkuskit/blocks");
    assert.equal(body.client_payload.requested_head, inputs.REQUESTED_HEAD);
    assert.equal(body.client_payload.publish, publish === "true");
    assert.equal(body.client_payload.origin_run_id, "12345");
    assert.equal(body.client_payload.origin_repository, "dinkuskit/blocks");
  }
});

test("malformed relay inputs fail before a dispatch payload exists", () => {
  for (const [key, value] of Object.entries({
    RELAY_REPOSITORY: "",
    TARGET_REPOSITORY: "../blocks",
    TARGET_REPOSITORY_ID: "false",
    PR_NUMBER: "1; echo bad",
    REQUESTED_HEAD: "main",
    REQUESTED_BASE: "short",
    PUBLISH: "yes",
    ORIGIN_REPOSITORY: "outside/blocks",
    ORIGIN_RUN_ID: "-1",
    ORIGIN_RUN_ATTEMPT: "0",
  })) {
    const result = spawnSync("python3", ["-I", "-"], {
      input: python,
      encoding: "utf8",
      env: { ...process.env, ...inputs, [key]: value },
    });
    assert.notEqual(result.status, 0, key);
    assert.equal(result.stdout, "", key);
  }
});

test("relay binds its exact request artifact before dispatch", () => {
  const [prepare, artifact, dispatch] = workflow.jobs.relay.steps;
  assert.equal(artifact.uses, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  assert.equal(artifact.with.name, "clawsweeper-request-${{ github.run_attempt }}");
  assert.equal(artifact.with.path, "${{ runner.temp }}/clawsweeper-request.json");
  assert.equal(artifact.with["if-no-files-found"], "error");
  assert.match(prepare.run, /origin_run_attempt/);
  assert.doesNotMatch(prepare.run, /gh api --method POST/);
  assert.match(dispatch.run, /--input "\$RUNNER_TEMP\/clawsweeper-request.json"/);
});

const sendStep = workflow.jobs.relay.steps[2];
const queuePython = sendStep.run
  .split("<<'PYQUEUE'")[1]
  .split("\n")
  .slice(1)
  .join("\n")
  .split("\nPYQUEUE")[0];

function queueFixture() {
  const dir = mkdtempSync(join(tmpdir(), "canary-queue-"));
  const client_payload = {
    target_repo: "dinkuskit/blocks",
    repository_id: "1306882611",
    pr: "47",
    requested_base: "a".repeat(40),
    requested_head: "b".repeat(40),
    origin_repository: "dinkuskit/blocks",
    origin_run_id: "12345",
    origin_run_attempt: "1",
    comment_id: "",
    publish: true,
  };
  writeFileSync(
    join(dir, "clawsweeper-request.json"),
    JSON.stringify({ event_type: "clawsweeper_native_pr", client_payload }),
  );
  return dir;
}

function runQueue(pythonSource, env) {
  return spawnSync("python3", ["-I", "-"], {
    input: pythonSource,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runQueueAsync(pythonSource, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-I", "-"], {
      env: { ...process.env, ...env },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
    child.stdin.end(pythonSource);
  });
}

test("queue dual-write is inert unless shadow or primary is selected", () => {
  const dir = queueFixture();
  for (const [mode, secret, expected] of [
    ["off", "", 0],
    ["", "", 0],
    ["shadow", "", 0],
    ["primary", "", 1],
  ]) {
    const result = runQueue(queuePython, {
      RUNNER_TEMP: dir,
      CLAWSWEEPER_DO_QUEUE_MODE: mode,
      CLAWSWEEPER_DO_QUEUE_SECRET: secret,
    });
    assert.equal(result.status, expected, `${mode || "unset"}: ${result.stderr}`);
  }
  assert.match(sendStep.run, /queue_status.*86/);
  assert.match(sendStep.run, /skipping Actions repository_dispatch/);
});

test("queue dual-write signs the exact admit and primary acceptance exits 86", async () => {
  const dir = queueFixture();
  const secret = "synthetic-test-secret";
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
      const got = request.headers["x-clawsweeper-exact-review-signature"];
      seen.push({
        url: request.url,
        admit: JSON.parse(raw.toString()),
        signature_ok:
          typeof got === "string" && timingSafeEqual(Buffer.from(got), Buffer.from(expected)),
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ accepted: true, deduped: false }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const localPython = queuePython.replace("https://queue.ztoned.com", `http://127.0.0.1:${port}`);
    const shadow = await runQueueAsync(localPython, {
      RUNNER_TEMP: dir,
      CLAWSWEEPER_DO_QUEUE_MODE: "shadow",
      CLAWSWEEPER_DO_QUEUE_SECRET: secret,
    });
    assert.equal(shadow.status, 0, shadow.stderr);
    const primary = await runQueueAsync(localPython, {
      RUNNER_TEMP: dir,
      CLAWSWEEPER_DO_QUEUE_MODE: "primary",
      CLAWSWEEPER_DO_QUEUE_SECRET: secret,
    });
    assert.equal(primary.status, 86, primary.stderr);
  } finally {
    server.close();
  }
  assert.equal(seen.length, 2);
  for (const entry of seen) {
    assert.equal(entry.url, "/internal/intake/admit");
    assert.equal(entry.signature_ok, true);
    assert.equal(entry.admit.requestId, "native:12345:1");
    assert.equal(entry.admit.repository, "dinkuskit/blocks");
    assert.equal(entry.admit.clientPayload.origin_run_id, "12345");
  }
});
