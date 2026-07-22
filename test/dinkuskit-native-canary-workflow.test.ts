import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};

type Job = {
  if?: string;
  env?: Record<string, unknown>;
  permissions?: Record<string, string>;
  steps?: Step[];
};

type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  jobs?: Record<string, Job>;
};

const path = ".github/workflows/dinkuskit-native-canary.yml";
const source = readFileSync(path, "utf8");
const workflow = parse(source) as Workflow;

function job(name: string): Job {
  const value = workflow.jobs?.[name];
  assert.ok(value, `missing ${name} job`);
  return value;
}

function jobSource(name: string): string {
  return JSON.stringify(job(name));
}

function step(jobName: string, name: string): Step {
  const value = (job(jobName).steps ?? []).find((candidate) => candidate.name === name);
  assert.ok(value, `missing ${jobName} step: ${name}`);
  return value;
}

test("DinkusKit canary is manual-only and exact-target scoped", () => {
  assert.deepEqual(Object.keys(workflow.on ?? {}), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.env?.TARGET_REPO, "dinkuskit/blocks");
  assert.equal(workflow.env?.TARGET_REPOSITORY_ID, "1306882611");
  assert.equal(workflow.env?.STATE_REPO, "dinkuskit/clawsweeper-state");
  assert.equal(workflow.env?.UPSTREAM_BASE_SHA, "e9423a404ffe6527373b84053e1df4d0d8bbd77b");
  assert.match(source, /PR_NUMBER" != "7"/);
  assert.match(source, /expected_base_sha must be a lowercase 40-character SHA/);
  assert.match(source, /expected_head_sha must be a lowercase 40-character SHA/);
});

test("review and publisher keep model and write credentials in separate steps and jobs", () => {
  const review = jobSource("review");
  const publish = jobSource("publish");
  const runReview = JSON.stringify(step("review", "Run the native ClawSweeper review"));
  assert.deepEqual(job("review").permissions, { contents: "read" });
  assert.match(review, /setup-codex/);
  assert.match(review, /OPENAI_API_KEY/);
  assert.match(review, /CLAWSWEEPER_MODEL/);
  assert.match(review, /create-github-app-token/);
  assert.doesNotMatch(runReview, /CLAWSWEEPER_APP_PRIVATE_KEY/);
  assert.doesNotMatch(runReview, /OPENAI_API_KEY/);
  assert.doesNotMatch(runReview, /CLAWSWEEPER_PROOF_INSPECTION_TOKEN/);
  assert.match(runReview, /steps\.review-token\.outputs\.token/);
  assert.match(publish, /CLAWSWEEPER_APP_PRIVATE_KEY/);
  assert.match(publish, /create-github-app-token/);
  assert.doesNotMatch(publish, /OPENAI_API_KEY/);
  assert.doesNotMatch(publish, /CLAWSWEEPER_MODEL/);
  assert.doesNotMatch(publish, /setup-codex/);
  assert.equal(job("publish").if, "${{ inputs.publish }}");
});

test("canary invokes native review and comment-only apply without workflow-authored target builds", () => {
  const review = jobSource("review");
  const publish = jobSource("publish");
  assert.match(review, /dist\/clawsweeper\.js review/);
  assert.match(review, /--local-only/);
  assert.match(review, /--readonly-openclaw/);
  assert.match(review, /--codex-sandbox read-only/);
  assert.match(review, /--codex-timeout-ms 1200000/);
  assert.match(review, /--disable-media-proof-preprocessing/);
  assert.match(review, /validate-dinkuskit-canary-report/);
  assert.match(review, /repair:exact-review-bundle create/);
  const targetSteps = (job("review").steps ?? []).filter((step) =>
    /target checkout|native ClawSweeper review/i.test(step.name ?? ""),
  );
  assert.equal(targetSteps.length, 2);
  for (const step of targetSteps) {
    assert.doesNotMatch(step.run ?? "", /(?:npm|pnpm|yarn|bun)\s+(?:install|run|test|build)/i);
  }

  assert.match(publish, /repair:exact-review-bundle validate/);
  assert.match(publish, /pnpm run apply-artifacts/);
  assert.match(publish, /pnpm run apply-decisions/);
  assert.match(publish, /validate-dinkuskit-canary-publication/);
  assert.match(publish, /apply-report\.json/);
  assert.match(publish, /--sync-comments-only/);
  assert.match(publish, /--suppress-automation-markers/);
  assert.match(publish, /--limit 0/);
  assert.doesNotMatch(
    publish,
    /(?:gh pr merge|gh pr close|repair:dispatch|repair:worker|automerge)/i,
  );
});

test("publisher consumes the exact review artifact and producer attempt across failed-job reruns", () => {
  const review = jobSource("review");
  const publish = jobSource("publish");
  assert.match(review, /review-artifact/);
  assert.match(review, /artifact-id/);
  assert.match(review, /producer_attempt/);
  assert.match(publish, /artifact-ids/);
  assert.match(publish, /needs\.review\.outputs\.artifact_id/);
  assert.match(publish, /needs\.review\.outputs\.producer_attempt/);
  assert.doesNotMatch(
    JSON.stringify(step("publish", "Download the native review bundle")),
    /github\.run_attempt/,
  );
});

test("all external actions in the canary use immutable commit pins", () => {
  const steps = Object.values(workflow.jobs ?? {}).flatMap((candidate) => candidate.steps ?? []);
  const external = steps
    .map((step) => step.uses)
    .filter((uses): uses is string => Boolean(uses && !uses.startsWith("./")));
  assert.ok(external.length > 0);
  for (const uses of external) {
    assert.match(uses, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/, uses);
  }
});

test("publisher requests only target comment/label and isolated state capabilities", () => {
  const publish = jobSource("publish");
  assert.match(publish, /permission-contents":"read/);
  assert.match(publish, /permission-checks":"read/);
  assert.match(publish, /permission-issues":"write/);
  assert.match(publish, /permission-pull-requests":"write/);
  assert.match(publish, /permission-statuses":"read/);
  assert.match(publish, /repositories":"blocks/);
  assert.match(publish, /repositories":"clawsweeper-state/);
  assert.match(publish, /permission-contents":"write/);
  assert.doesNotMatch(publish, /permission-(?:actions|checks|deployments|workflows)":"write/);
});

test("cross-repository reads use narrow App tokens instead of the control GITHUB_TOKEN", () => {
  const admission = JSON.stringify(step("admit", "Mint the repository-scoped admission token"));
  const reviewToken = JSON.stringify(step("review", "Mint the repository-scoped review token"));
  const preflight = JSON.stringify(
    step("publish", "Mint the repository-scoped publication preflight token"),
  );
  assert.match(admission, /permission-contents":"read/);
  assert.match(admission, /permission-pull-requests":"read/);
  assert.match(reviewToken, /permission-checks":"read/);
  assert.match(reviewToken, /permission-contents":"read/);
  assert.match(reviewToken, /permission-issues":"read/);
  assert.match(reviewToken, /permission-pull-requests":"read/);
  assert.match(reviewToken, /permission-statuses":"read/);
  assert.match(preflight, /permission-contents":"read/);
  assert.match(preflight, /permission-issues":"read/);
  assert.match(preflight, /permission-pull-requests":"read/);
  assert.doesNotMatch(source, /GH_TOKEN:\s*\$\{\{ github\.token \}\}/);
});

test("Codex runs through a credential-empty unprivileged wrapper", () => {
  const prepare = JSON.stringify(step("review", "Prepare the unprivileged Codex runtime"));
  const revoke = JSON.stringify(step("review", "Revoke model runtime write access"));
  const wrapper = readFileSync("scripts/run-codex-unprivileged.sh", "utf8");
  assert.match(prepare, /adduser --system/);
  assert.match(prepare, /clawsweeper-share/);
  assert.doesNotMatch(prepare, /groups "\$runner_group"/);
  assert.doesNotMatch(prepare, /groups "\$USER"/);
  assert.match(prepare, /unexpectedly retained sudo authority/);
  assert.match(prepare, /root:root/);
  assert.match(prepare, /chmod -R a-w/);
  assert.match(prepare, /safe\.directory.*\$CANARY_TARGET/);
  assert.doesNotMatch(prepare, /safe\.directory[^\n]*\*/);
  assert.match(revoke, /pkill --signal KILL --uid/);
  assert.match(revoke, /chmod -R go-w/);
  assert.match(wrapper, /sudo --non-interactive --set-home --user=/);
  assert.match(wrapper, /\/usr\/bin\/env -i/);
  assert.match(wrapper, /CLAWSWEEPER_PROOF_SCRATCH_DIR/);
  assert.match(wrapper, /GIT_CONFIG_GLOBAL="\$CLAWSWEEPER_MODEL_GIT_CONFIG"/);
  assert.doesNotMatch(wrapper, /GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|APP_PRIVATE_KEY/);
  assert.match(source, /CANARY_ROOT:\s*\/opt\/dinkuskit-clawsweeper-canary/);
  assert.doesNotMatch(
    source,
    /\$RUNNER_TEMP\/(?:dinkuskit-blocks|review-artifacts|clawsweeper-model)/,
  );
});

test("target checkout completes before any API-key proxy exists and ignores ambient Git config", () => {
  const steps = job("review").steps ?? [];
  const checkoutIndex = steps.findIndex(
    (candidate) => candidate.name === "Prepare the exact target checkout as read-only data",
  );
  const proxyIndex = steps.findIndex(
    (candidate) => candidate.name === "Set up pinned Codex through the upstream localhost proxy",
  );
  assert.ok(checkoutIndex >= 0);
  assert.ok(proxyIndex > checkoutIndex);

  const hardenedKeys = [
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_ATTR_NOSYSTEM",
    "GIT_TERMINAL_PROMPT",
  ];
  for (const key of hardenedKeys) assert.ok(!(key in (job("review").env ?? {})));
  for (const stepName of [
    "Prepare the exact target checkout as read-only data",
    "Run the native ClawSweeper review",
    "Validate the exact native report and live tuple",
  ]) {
    const hardenedStep = step("review", stepName);
    for (const key of hardenedKeys)
      assert.ok(key in (hardenedStep.env ?? {}), `${stepName}: ${key}`);
  }

  const wrapper = readFileSync("scripts/run-codex-unprivileged.sh", "utf8");
  assert.match(wrapper, /GIT_CONFIG_NOSYSTEM=1/);
  assert.match(wrapper, /GIT_CONFIG_GLOBAL="\$CLAWSWEEPER_MODEL_GIT_CONFIG"/);
  assert.match(wrapper, /GIT_ATTR_NOSYSTEM=1/);
  assert.match(wrapper, /GIT_TERMINAL_PROMPT=0/);
});

test("public canary disables trusted-host media preprocessing in the native engine", () => {
  const engine = readFileSync("src/clawsweeper.ts", "utf8");
  assert.match(engine, /boolArg\(args\.disable_media_proof_preprocessing\)/);
  assert.match(engine, /localRangeData \|\| disableMediaProofPreprocessing/);
});
