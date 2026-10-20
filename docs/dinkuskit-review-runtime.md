# DinkusKit review runtime

Enrolled DinkusKit product and review-infrastructure repositories each use their own deterministic CI, agent-owned OpenClaw review, and native ClawSweeper review. The review models run on the maintainer-managed Spark-2 Codex OpenAI subscription. GitHub-hosted jobs only bind and relay events; they do not run a model. CI does not dispatch or sequence the reviewers.

The shared `dinkuskit-native-canary.yml` entry point retains its name for caller compatibility. It accepts an exact repository ID, PR, base, head, and publication choice, and sends one native event to the configured private receiver. The receiver re-reads repository identity, source workflow, maintainer permissions, PR readiness, and current source before invoking the existing subscription runtime. It repeats source checks afterward. A successful relay is not a completed or clean review.

Each caller configures `CLAWSWEEPER_SPARK_ENABLED`, `CLAWSWEEPER_RELAY_REPOSITORY`, and the narrowly scoped `CLAWSWEEPER_DISPATCH_TOKEN`. Model credentials stay on the host. Existing Copilot secrets are not used by this route. Configuration and activation are separate maintainer operations; source changes do not provision credentials or start a runner.

Copy the binder from `.github/workflows/clawsweeper-dispatch.yml` into each enrolled repository, then set that copy's `TARGET_REPO` / `TARGET_ID` (and the reusable-workflow `target_repository*` inputs) to the enrolled repo. The bind script admits bot-authored PRs only for the fixed ID-verified allowlist shared across both tenants (`smoky-agent[bot]` 343990805 and, on `dinkuskit/*` targets, `dinkuskit-release[bot]` 342199489); there is no per-repo trusted-bot variable and no login-only default. A PR from any other bot is not admitted until a maintainer applies the `clawsweeper:review` label or posts a standalone `@clawsweeper review` command. Label admissions bind the human labeler into the signed request, and the receiver revalidates that labeler's live admin/maintain/write permission at execution, so revoked authority cannot ride the queue. Human PR actors and `workflow_dispatch` are unaffected. `issue_comment` commands are maintainer-only and still refuse bot comments in the bind script. Draft PRs still clean-skip after bind.

Enrolled binder copies that need the same dispatch-side bot guard (do not open those PRs from this change):

- `dinkuskit/clawsweeper` (this template)
- `dinkuskit/blocks`
- `dinkuskit/bundles`
- `dinkuskit/commerce`
- `dinkuskit/coupons`
- `dinkuskit/dinkuskit`
- `dinkuskit/inventory`
- `dinkuskit/payments`
- `dinkuskit/ship`
- `dinkuskit/template-store`
- `dinkuskit/template-services`
- `dinkuskit/template-marketing`
- `saari-co/SmokySkills` (when that repo's binder is present)

Native events include opened, reopened, edited, synchronized, and ready-for-review PRs. Trusted maintainers can request `@clawsweeper review` or `@clawsweeper re-review`. A manual workflow run can request proposal-only evidence with publication disabled. Drafts and stale source are rejected. Automatic fork reviews require a trusted maintainer command. Review comments, labels, and the DinkusKit state ledger remain native outputs; repair, close, merge, release, and deployment are not authorized by a review.

Before merge, the working agent checks CI and both reviewers against the current source and resolves findings. Queue receipts and labels alone do not satisfy that requirement. Repo-specific human approval rules remain in force.

The organization `.github` repository is excluded from review-rail enrollment by maintainer decision.

The relay uploads its exact request as a run-attempt artifact before dispatch. The receiver verifies its GitHub digest and exact payload equality, so a previous run cannot authorize another PR tuple or publication choice.
