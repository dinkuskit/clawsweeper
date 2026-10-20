import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const source = readFileSync(".github/workflows/clawsweeper-dispatch.yml", "utf8");
const workflow = parse(source) as {
  jobs: { bind: { if?: string }; review: Record<string, unknown> };
};

test("dispatch binder admits only ID-verified trusted bots and maintainer labels", () => {
  const bindIf = String(workflow.jobs.bind.if ?? "");
  assert.match(bindIf, /vars\.CLAWSWEEPER_SPARK_ENABLED == 'true'/);
  assert.match(bindIf, /github\.event_name != 'pull_request_target'/);
  assert.match(
    source,
    /TRUSTED_BOTS = \{'smoky-agent\[bot\]': 343990805, 'dinkuskit-release\[bot\]': 342199489\}/,
  );
  assert.match(source, /\(user or \{\}\)\.get\('id'\) != expected/);
  assert.match(
    source,
    /user\.get\('login'\) == 'dinkuskit-release\[bot\]' and not target\.startswith\('dinkuskit\/'\)/,
  );
  assert.match(source, /author\.get\('type'\) == 'Bot' and not bot_trusted\(author\): skip\(\)/);
  assert.match(
    source,
    /\(event\.get\('label'\) or \{\}\)\.get\('name'\) != 'clawsweeper:review': skip\(\)/,
  );
  assert.match(source, /permission not in \('admin', 'maintain', 'write'\): skip\(\)/);
  assert.match(source, /force_label_by = sender\['login'\]/);
  assert.doesNotMatch(source, /CLAWSWEEPER_TRUSTED_BOTS|cursor\[bot\]/);
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
