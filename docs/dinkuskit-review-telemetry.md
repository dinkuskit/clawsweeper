# DinkusKit Native Review Telemetry

Read when changing the DinkusKit native-canary state publication path, the
`clawsweeper.telemetry.v1` producer, or the dashboard feeder contract consumed
by the Saari unified review dashboard.

## What It Is

After a successful native comment/label publication, the existing `publish` job
writes one tenant envelope to:

```text
dinkuskit/clawsweeper-state@state:results/review-telemetry/dinkuskit.json
```

The producer is `scripts/publish-dinkuskit-review-telemetry.mjs`. It is a pure
Node 24 validator/writer. It does not push, mint tokens, call GitHub, or deploy
Workers. The existing globally serialized state-writer commit remains the only
state mutation.

## When It Runs

The step `Publish DinkusKit review telemetry into the same state tree` runs in
`.github/workflows/dinkuskit-native-canary.yml` only after:

1. `admit` and `review` succeeded
2. `inputs.publish` is true
3. exact-review bundle validation succeeded
4. native publication validation succeeded

It runs immediately before the existing single `git add` / `commit` / `push`.
The add path is exactly:

```text
records/$STATE_SLUG
results/review-telemetry/dinkuskit.json
```

There is no second workflow, cron, competing writer, or second state push.

## Trust Model

Rows are derived only from trusted native-canary facts already bound by
admission and publication validation:

- exact `dinkuskit/<allowlisted-repo>` and repository ID pair
- exact PR number, base SHA, head SHA, and engine SHA
- complete verified native report
- published comment URL and rating label when present

Missing CI, OpenClaw, rating, findings, or verdict conclusions stay
`unknown`/null. The producer never invents zero, success, or failure.

Existing `results/review-telemetry/dinkuskit.json` is untrusted input. The
publisher fails closed on a symlink, oversized body, extra fields, wrong
tenant, non-allowlisted repository, malformed or future timestamp, invalid SHA,
row cap overflow, or any secret/local-path payload. It does not copy arbitrary
fields into state. An idle existing envelope is accepted: old valid historical
rows are retained during the bounded upsert, and rejecting them would block
first publication after an idle period.

## Envelope

`schema_version` is `clawsweeper.telemetry.v1`. `tenant` is `dinkuskit`. Lane
boundaries stay DinkusKit-owned:

- app installation: `dinkuskit-clawsweeper[bot]`
- queue namespace: `dinkuskit-native-clawsweeper-state-writer`
- state store: `dinkuskit/clawsweeper-state@state`
- mutation authority: `dinkuskit/clawsweeper native-canary publish job`

`generated_at` is the publication clock and refreshes on each new publish.
`stale_after_seconds` is `900`. Row freshness uses `observed_at` from
`reviewed_at` when that timestamp is valid. A valid `observed_at` older than
`stale_after_seconds` is kept and surfaces stale; it is not a publisher
rejection.

Proof links are GitHub https URLs only: the PR, the published review comment
when known, and the caller workflow run when supplied. Local paths, tokens,
headers, raw upstream bodies, and private payloads are rejected.

## Consumer Repin

The Saari feeder reads this exact path through a separate read-only Worker.
Publishing this file does not deploy that Worker and does not couple DinkusKit
credentials to Saari or Spark-2. Callers must still repin both the reusable
workflow ref and `engine_sha` to the same commit before a live canary can emit
the new file.
