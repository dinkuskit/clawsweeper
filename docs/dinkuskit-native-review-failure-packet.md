# DinkusKit Native Review Failure Packet

Read when changing the DinkusKit native-review lane's failure diagnostics, the
Copilot/Codex adapter's classification, or the sanitized failure packet
collector.

## What It Is

When the isolated Copilot/Codex adapter fails inside the `review` job of the
reusable `.github/workflows/dinkuskit-native-canary.yml` workflow, the review
step, bundle, and upload steps that normally publish a downloadable review
bundle are skipped. Without a separate mechanism, the only trace of the
failure was the `::error` annotation from the "Report the bounded Copilot
failure class" step; adapter stdout/stderr, the partial native report, and any
native decision output stayed runner-local and unrecoverable.

The failure packet is a bounded, sanitized artifact bundle assembled only on
review failure, containing whatever bounded diagnostics the isolated model
process left behind. It exists purely for operator triage. It never feeds back
into publish decisions, comments, labels, or state.

## When It Is Produced

Two new `review`-job steps run only `if: ${{ failure() }}`, placed after
"Revoke model runtime write access" and after "Report the bounded Copilot
failure class":

1. **Assemble the sanitized native review failure packet** — invokes
   `scripts/collect-native-review-failure-packet.mjs` against the review
   step's artifact directory and writes a bounded packet to
   `$RUNNER_TEMP/native-review-failure-packet`. If the pinned engine checkout
   itself is unavailable (the collector script does not exist), it falls back
   to writing minimal `metadata.json` with `jq` instead.
2. **Upload the sanitized native review failure packet** — uploads that
   directory as a GitHub Actions artifact.

Both steps run after model runtime write access has already been revoked and
the artifact tree has been chowned back to the runner user, so the collector
never contends with, or trusts, a live unprivileged process.

## Trust Model

The artifact tree under `CANARY_ARTIFACTS` is written partly by an
unprivileged model process (the isolated Copilot/Codex adapter) that never
holds write credentials but does have read access to the target checkout and
a proof scratch directory. The collector therefore treats everything under
that tree as **untrusted input**, not as its own output:

- Every file is checked with `lstatSync` before reading; anything that is not
  a regular, non-symlink file is skipped outright (this rules out symlink
  traversal out of the artifact tree).
- Every read is capped. Diagnostic JSON files are re-parsed and
  **re-serialized** field-by-field from an explicit allowlist — raw bytes for
  `copilot-failure.json` and `copilot-adapter-status.json` are never copied,
  only the exact keys the packet's schema names.
- Every other copied text file (adapter logs, the partial native report, and
  the native decision output) is redacted after truncation, so a token that
  is split across the truncation boundary cannot survive intact in either
  half.
- The two workflow steps that assemble and upload the packet declare no
  secrets, no `GH_TOKEN`, and no `COPILOT_GITHUB_TOKEN` in their `env:` block.
  The collector script itself refuses to run at all if
  `COPILOT_GITHUB_TOKEN` is present in its environment, structurally
  preventing a future edit from wiring model credentials into this path.

## Packet Contents

| File                            | Source                                   | Handling                                                              |
| -------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| `copilot-failure.json`           | `codex/copilot-failure.json`              | Re-serialized allowlisted keys only, when valid.                       |
| `copilot-adapter-status.json`    | `codex/copilot-adapter-status.json`       | Re-serialized allowlisted keys only, when valid.                       |
| `<item>.<attempt>.codex.stdout.log` | `codex/<item>.<attempt>.codex.stdout.log` | Last 64 KiB, UTF-8 lossy decoded, redacted; attempts 1-5.               |
| `<item>.<attempt>.codex.stderr.log` | `codex/<item>.<attempt>.codex.stderr.log` | Last 64 KiB, UTF-8 lossy decoded, redacted; attempts 1-5.               |
| `partial-native-report.md`       | `<item>.md`                               | First 128 KiB, redacted.                                                |
| `native-decision-output.json`    | `codex/<item>.json`                       | First 64 KiB, redacted.                                                 |
| `metadata.json`                  | (generated)                               | Never truncated or budget-limited; carries the run tuple and file list. |

Total copied content across every file above (excluding `metadata.json`) is
capped at 1 MiB. A file that would push the packet over that cap is skipped
entirely, and the skip is recorded both in `metadata.json`'s `files` entry and
in its `notes`.

## Failure Categories

`metadata.json`'s `failure_category` is one of thirteen values. Ten come from
the adapter's own deterministic classifier
(`classifyCopilotFailure` in `scripts/run-copilot-codex-adapter.mjs`); three
are workflow-level fallbacks the collector derives when no bounded diagnostic
was recorded at all.

| Category              | Meaning                                                                 |
| ---------------------- | -------------------------------------------------------------------------- |
| `authentication`       | Copilot token invalid, expired, revoked, or otherwise unverifiable.     |
| `copilot_access`       | Copilot license/subscription/policy denied access.                     |
| `model_access`         | The configured model is unavailable for the account.                   |
| `cli_contract`         | Copilot CLI rejected an option/argument/tool the adapter passed.       |
| `response_contract`    | Copilot ran but did not submit a valid native decision.                |
| `network`              | Transport-level failure reaching Copilot.                              |
| `rate_limited`         | Copilot reported HTTP 429, rate limiting, or exhausted quota/credits.  |
| `server_error`         | Copilot reported an HTTP 5xx / gateway-class failure.                  |
| `execution`            | The adapter itself could not run the CLI (spawn error, signal, bounded file/path failures). |
| `unclassified`         | **Safe fallback** — a diagnostic was recorded but did not match any known pattern. |
| `native_postprocess`   | The Copilot CLI was accepted by the native tool but the review job still failed afterward. |
| `adapter_handoff`      | The adapter recorded acceptance telemetry, but no bounded failure diagnostic and no native output exist. |
| `adapter_boundary`     | No bounded diagnostic and no adapter telemetry exist at all — failure happened before or fully outside the adapter. |

`unclassified` is the deliberate safe fallback for both the workflow's `jq`
check and the collector: an invalid or unrecognized diagnostic should never
silently disappear or be miscategorized as something more specific than the
evidence supports.

## Artifact Name And Retention

The packet uploads as:

```text
dinkuskit-native-review-failure-<run_id>-<run_attempt>
```

with 30-day retention, matching the existing bounded native review bundle's
retention window. Unlike that bundle (`if-no-files-found: error`), the
failure packet upload uses `if-no-files-found: warn`, since a failure that
happens before the engine checkout completes may legitimately produce only
the `jq`-generated fallback metadata, or in edge cases nothing at all.

## Downloading A Packet

```bash
gh run download <run-id> --repo <caller-repo> -n dinkuskit-native-review-failure-<run_id>-<run_attempt>
```

Replace `<caller-repo>` with the repository that invoked the reusable
workflow (the caller, not `dinkuskit/clawsweeper`), and `<run-id>` with that
caller's run ID from the failed dispatch.

## Fail-Closed Guarantee

The failure packet is strictly additive observability. It changes nothing
about the workflow's existing fail-closed contract:

- The `publish` job still requires `needs: [admit, review]` and
  `if: ${{ inputs.publish }}` — it does not gain an `always()` or `failure()`
  path, and never runs the failure-class or packet-assembly steps.
- A failed `review` job still cannot produce a downloadable review bundle
  (`if-no-files-found: error` on that upload is unchanged), so a failure can
  never be mistaken for a passing review by anything downstream.
- The packet-assembly and upload steps hold no write credentials and touch no
  comment, label, or state surface. They can only ever produce more
  diagnostic evidence for a run that has already failed.

## Consumer Repin

Callers of this reusable workflow pin **both** the workflow ref and the
`engine_sha` input to the same commit:

```yaml
jobs:
  review:
    uses: dinkuskit/clawsweeper/.github/workflows/dinkuskit-native-canary.yml@<engine-sha>
    with:
      engine_sha: <engine-sha>
      # ...other inputs
```

To pick up the failure packet (or any other engine change), callers must
repin **both** values to a commit at or after this change. Repinning only one
of them is not rejected automatically — the workflow's SHA checks bind the
engine checkout to `engine_sha`, not to the workflow's own ref — so a
mismatched pair silently runs a skewed workflow/engine combination that no
one has tested. Keep the two values identical.
