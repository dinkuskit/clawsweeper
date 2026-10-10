import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const source = readFileSync(".github/workflows/clawsweeper-dispatch.yml", "utf8");
const workflow = parse(source) as {
  jobs: { bind: { if?: string }; review: Record<string, unknown> };
};

test("dispatch binder defaults trusted bots and skips untrusted bot PR actors", () => {
  const bindIf = String(workflow.jobs.bind.if ?? "");
  assert.match(bindIf, /vars\.CLAWSWEEPER_SPARK_ENABLED == 'true'/);
  assert.match(bindIf, /github\.event_name != 'pull_request_target'/);
  assert.match(bindIf, /github\.event\.sender\.type != 'Bot'/);
  assert.match(bindIf, /endsWith\(github\.actor, '\[bot\]'\)/);
  assert.match(bindIf, /vars\.CLAWSWEEPER_TRUSTED_BOTS \|\| 'cursor\[bot\]'/);
  assert.match(bindIf, /format\(',\{0\},', github\.actor\)/);
});

test("dispatch binder keeps issue_comment bot refusal in the bind script", () => {
  assert.match(source, /if kind == 'issue_comment':/);
  assert.match(source, /comment\['user'\]\['type'\] == 'Bot': skip\(\)/);
  assert.doesNotMatch(
    String(workflow.jobs.bind.if ?? ""),
    /issue_comment.*trusted|CLAWSWEEPER_TRUSTED_BOTS.*issue_comment/s,
  );
});

test("dispatch binder still clean-skips draft PRs before review", () => {
  assert.match(source, /pull\['state'\] != 'open' or pull\['draft'\]: skip\(\)/);
  assert.equal(workflow.jobs.review.if, "needs.bind.outputs.requested == 'true'");
});
