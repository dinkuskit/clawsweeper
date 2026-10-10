import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  assert.deepEqual(Object.keys(workflow.on.workflow_call.secrets), ["CLAWSWEEPER_DISPATCH_TOKEN"]);
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
  const [prepare, queue, artifact, dispatch] = workflow.jobs.relay.steps;
  assert.equal(artifact.uses, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  assert.equal(artifact.with.name, "clawsweeper-request-${{ github.run_attempt }}");
  assert.equal(artifact.with.path, "${{ runner.temp }}/clawsweeper-request.json");
  assert.equal(artifact.with["if-no-files-found"], "error");
  assert.match(prepare.run, /origin_run_attempt/);
  assert.equal(queue.id, "admit-do-queue");
  assert.doesNotMatch(prepare.run, /gh api --method POST/);
  assert.match(dispatch.run, /--input "\$RUNNER_TEMP\/clawsweeper-request.json"/);
});

test("DO queue modes preserve legacy fallback and never expose the secret", () => {
  const [, queue, artifact, dispatch] = workflow.jobs.relay.steps;
  assert.equal(queue["continue-on-error"], true);
  assert.match(String(queue.if), /'shadow'/);
  assert.match(String(queue.if), /'primary'/);
  assert.match(String(queue.run), /sha256=/);
  assert.match(String(queue.run), /hmac\.new/);
  assert.match(String(queue.run), /\/admit/);
  assert.match(String(queue.run), /x-clawsweeper-queue-signature/);
  assert.match(String(queue.run), /https/);
  assert.match(String(queue.run), /workers\.dev/);
  assert.doesNotMatch(String(queue.run), /echo.*QUEUE_SECRET|print\(.*secret/i);
  assert.match(String(artifact.if), /steps\.admit-do-queue\.outcome/);
  assert.match(String(dispatch.if), /steps\.admit-do-queue\.outcome/);
  assert.match(String(dispatch.if), /'primary'/);
});
