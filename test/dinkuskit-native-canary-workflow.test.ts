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

test("DinkusKit canary is reusable and binds a caller-supplied exact public repository", () => {
  assert.deepEqual(Object.keys(workflow.on ?? {}), ["workflow_dispatch", "workflow_call"]);
  assert.match(source, /workflow_call:[\s\S]*COPILOT_GITHUB_TOKEN:[\s\S]*required: true/);
  assert.match(source, /workflow_call:[\s\S]*CLAWSWEEPER_APP_PRIVATE_KEY:[\s\S]*required: true/);
  assert.match(source, /target_repository:[\s\S]*required: true[\s\S]*type: string/);
  assert.match(source, /target_repository_id:[\s\S]*required: true[\s\S]*type: string/);
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.env?.TARGET_REPOSITORY, "${{ inputs.target_repository }}");
  assert.equal(
    workflow.env?.TARGET_REPO,
    "${{ format('dinkuskit/{0}', inputs.target_repository) }}",
  );
  assert.equal(workflow.env?.TARGET_REPOSITORY_ID, "${{ inputs.target_repository_id }}");
  assert.equal(
    workflow.env?.STATE_SLUG,
    "${{ format('dinkuskit-{0}', inputs.target_repository) }}",
  );
  assert.equal(workflow.env?.STATE_REPO, "dinkuskit/clawsweeper-state");
  assert.equal(workflow.env?.UPSTREAM_BASE_SHA, "e9423a404ffe6527373b84053e1df4d0d8bbd77b");
  const admissionSteps = job("admit").steps ?? [];
  const inputValidationIndex = admissionSteps.findIndex(
    (candidate) => candidate.name === "Validate immutable caller inputs",
  );
  const tokenIndex = admissionSteps.findIndex(
    (candidate) => candidate.name === "Mint the repository-scoped admission token",
  );
  assert.ok(inputValidationIndex >= 0);
  assert.ok(
    tokenIndex > inputValidationIndex,
    "inputs must be allowlisted before App token minting",
  );
  const inputValidation = admissionSteps[inputValidationIndex]?.run ?? "";
  for (const binding of [
    "blocks:1306882611",
    "template-store:1306882668",
    "template-services:1306882701",
    "template-marketing:1306882756",
    "inventory:1307843786",
    "coupons:1307843842",
    "bundles:1307843885",
  ]) {
    assert.match(inputValidation, new RegExp(binding));
  }
  assert.match(inputValidation, /not in the DinkusKit canary allowlist/);
  assert.match(source, /target_repository_id must be a positive numeric GitHub repository ID/);
  assert.match(source, /base_ref" != "\$default_branch"/);
  assert.match(source, /visibility" != "public"/);
  assert.doesNotMatch(source, /dinkuskit\/blocks|PR_NUMBER" != "7"/);
  assert.match(source, /expected_base_sha must be a lowercase 40-character SHA/);
  assert.match(source, /expected_head_sha must be a lowercase 40-character SHA/);
});

test("review and publisher keep Copilot and write credentials in separate steps and jobs", () => {
  const review = jobSource("review");
  const publish = jobSource("publish");
  const runReview = JSON.stringify(step("review", "Run the native ClawSweeper review"));
  assert.deepEqual(job("review").permissions, { contents: "read" });
  assert.match(review, /@github\/copilot@1\.0\.73/);
  assert.match(review, /detect-libc@2\.1\.2/);
  assert.match(review, /COPILOT_GITHUB_TOKEN/);
  assert.match(review, /gpt-5\.6-terra/);
  assert.match(review, /CLAWSWEEPER_COPILOT_EFFORT=high/);
  assert.doesNotMatch(review, /OPENAI_API_KEY|setup-codex|CLAWSWEEPER_INTERNAL_MODEL/);
  assert.match(review, /create-github-app-token/);
  assert.doesNotMatch(runReview, /CLAWSWEEPER_APP_PRIVATE_KEY/);
  assert.doesNotMatch(runReview, /CLAWSWEEPER_PROOF_INSPECTION_TOKEN/);
  assert.match(runReview, /COPILOT_GITHUB_TOKEN/);
  assert.match(runReview, /steps\.review-token\.outputs\.token/);
  assert.match(publish, /CLAWSWEEPER_APP_PRIVATE_KEY/);
  assert.match(publish, /create-github-app-token/);
  assert.doesNotMatch(
    publish,
    /OPENAI_API_KEY|COPILOT_GITHUB_TOKEN|CLAWSWEEPER_COPILOT|setup-codex/,
  );
  assert.equal(job("publish").if, "${{ inputs.publish }}");
});

test("canary invokes native review and comment-only apply without workflow-authored target builds", () => {
  const review = jobSource("review");
  const publish = jobSource("publish");
  assert.match(review, /dist\/clawsweeper\.js review/);
  assert.match(review, /--local-only/);
  assert.match(review, /--readonly-openclaw/);
  assert.match(review, /--codex-sandbox read-only/);
  assert.match(review, /--codex-model gpt-5\.6-terra/);
  assert.match(review, /--codex-reasoning-effort high/);
  assert.match(review, /--codex-service-tier default/);
  assert.doesNotMatch(review, /--codex-service-tier fast/);
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
  assert.match(publish, /repositories":"\$\{\{ inputs\.target_repository \}\}"/);
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
  for (const tokenStep of [admission, reviewToken, preflight]) {
    assert.match(tokenStep, /repositories":"\$\{\{ inputs\.target_repository \}\}"/);
    assert.doesNotMatch(tokenStep, /repositories":"blocks/);
  }
  assert.doesNotMatch(source, /GH_TOKEN:\s*\$\{\{ github\.token \}\}/);
});

test("Copilot runs through a token-minimal unprivileged wrapper", () => {
  const install = JSON.stringify(
    step("review", "Install the pinned GitHub Copilot CLI without shared caches"),
  );
  const prepare = JSON.stringify(step("review", "Prepare the unprivileged Copilot runtime"));
  const revoke = JSON.stringify(step("review", "Revoke model runtime write access"));
  const failureClass = JSON.stringify(step("review", "Report the bounded Copilot failure class"));
  const wrapper = readFileSync("scripts/run-codex-unprivileged.sh", "utf8");
  assert.match(install, /GitHub Copilot CLI 1\.0\.73\./);
  assert.doesNotMatch(install, /--version\)" = "1\.0\.73"/);
  assert.match(prepare, /adduser --system/);
  assert.match(prepare, /clawsweeper-share/);
  assert.doesNotMatch(prepare, /groups "\$runner_group"/);
  assert.doesNotMatch(prepare, /groups "\$USER"/);
  assert.match(prepare, /unexpectedly retained sudo authority/);
  assert.match(prepare, /root:root/);
  assert.match(prepare, /chmod -R a-w/);
  assert.match(prepare, /safe\.directory.*\$CANARY_TARGET/);
  assert.doesNotMatch(prepare, /safe\.directory[^\n]*\*/);
  assert.match(revoke, /\$\{CLAWSWEEPER_MODEL_USER:-\}/);
  assert.match(revoke, /id \\"\$CLAWSWEEPER_MODEL_USER\\"/);
  assert.match(revoke, /pkill --signal KILL --uid/);
  assert.match(revoke, /chmod -R go-w/);
  assert.match(failureClass, /copilot-failure\.json/);
  assert.match(failureClass, /clawsweeper_copilot_failure/);
  assert.match(failureClass, /authentication/);
  assert.match(failureClass, /model_access/);
  assert.match(failureClass, /cli_contract/);
  assert.match(failureClass, /response_contract/);
  assert.doesNotMatch(failureClass, /codex\.stderr|COPILOT_GITHUB_TOKEN|\bcat\b/);
  assert.match(wrapper, /sudo --non-interactive --set-home --user=/);
  assert.match(wrapper, /\/usr\/bin\/env -i/);
  assert.match(wrapper, /CLAWSWEEPER_PROOF_SCRATCH_DIR/);
  assert.match(wrapper, /COPILOT_GITHUB_TOKEN="\$COPILOT_GITHUB_TOKEN"/);
  assert.match(wrapper, /CLAWSWEEPER_COPILOT_MODEL/);
  assert.match(wrapper, /CLAWSWEEPER_COPILOT_EFFORT/);
  assert.match(wrapper, /CLAWSWEEPER_COPILOT_DECISION_MCP="\$CLAWSWEEPER_COPILOT_DECISION_MCP"/);
  assert.match(wrapper, /GIT_CONFIG_GLOBAL="\$CLAWSWEEPER_MODEL_GIT_CONFIG"/);
  assert.doesNotMatch(wrapper, /\bGH_TOKEN\b|\bGITHUB_TOKEN\b|OPENAI_API_KEY|APP_PRIVATE_KEY/);
  assert.match(source, /CANARY_ROOT:\s*\/opt\/dinkuskit-clawsweeper-canary/);
  assert.doesNotMatch(source, /\$RUNNER_TEMP\/(?:review-artifacts|clawsweeper-model)/);
});

test("publication state is isolated under the verified dynamic repository slug", () => {
  const publish = jobSource("publish");
  assert.match(publish, /state_root=\\"\.\.\/state\/records\/\$STATE_SLUG\\"/);
  assert.match(publish, /git -C state add -- \\"records\/\$STATE_SLUG\\"/);
  assert.match(publish, /review: publish \$TARGET_REPO#\$PR_NUMBER/);
  assert.doesNotMatch(publish, /records\/dinkuskit-blocks/);
});

test("failed reviews report only bounded adapter or native failure classes", () => {
  const failureClass = JSON.stringify(step("review", "Report the bounded Copilot failure class"));
  assert.match(failureClass, /copilot-adapter-status\.json/);
  assert.match(failureClass, /native_postprocess/);
  assert.match(failureClass, /adapter_handoff/);
  assert.match(failureClass, /adapter_boundary/);
  assert.doesNotMatch(failureClass, /cat\s|copilot\.stderr|codex\.stderr/);
});

test("target checkout completes before Copilot installation and ignores ambient Git config", () => {
  const steps = job("review").steps ?? [];
  const checkoutIndex = steps.findIndex(
    (candidate) => candidate.name === "Prepare the exact target checkout as read-only data",
  );
  const copilotIndex = steps.findIndex(
    (candidate) => candidate.name === "Install the pinned GitHub Copilot CLI without shared caches",
  );
  assert.ok(checkoutIndex >= 0);
  assert.ok(copilotIndex > checkoutIndex);

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

test("reusable jobs check out and bind the explicit immutable engine commit", () => {
  for (const stepName of [
    "Check out the trusted ClawSweeper engine",
    "Check out the trusted ClawSweeper publisher",
  ]) {
    const jobName = stepName.includes("engine") ? "review" : "publish";
    const checkout = step(jobName, stepName);
    assert.equal(checkout.with?.repository, "dinkuskit/clawsweeper");
    assert.equal(checkout.with?.ref, "${{ inputs.engine_sha }}");
  }
  assert.match(source, /engine_sha:[\s\S]*required: true/);
  assert.match(source, /ENGINE_SHA: \$\{\{ inputs\.engine_sha \}\}/);
  assert.match(source, /\[\[ "\$ENGINE_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(source, /EXACT_REVIEW_SOURCE_SHA="\$ENGINE_SHA"/);
  assert.doesNotMatch(source, /GITHUB_(?:WORKFLOW_)?SHA|github\.sha|job\.workflow_/);
});

test("public canary disables trusted-host media preprocessing in the native engine", () => {
  const engine = readFileSync("src/clawsweeper.ts", "utf8");
  assert.match(engine, /boolArg\(args\.disable_media_proof_preprocessing\)/);
  assert.match(engine, /localRangeData \|\| disableMediaProofPreprocessing/);
});
