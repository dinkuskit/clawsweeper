#!/usr/bin/env bash

set -euo pipefail

URL="${RYAN_DESK_WEBHOOK_URL:-}"
KEY="${RYAN_DESK_WEBHOOK_KEY:-}"
EVENT="${WEBHOOK_EVENT:-review_completed}"

if [ -z "$URL" ] || [ -z "$KEY" ]; then
  echo "ryan-desk webhook secrets not set; skipping"
  exit 0
fi

KEY="$(printf '%s' "$KEY" | tr -d '\r\n')"
echo "::add-mask::$KEY"
echo "::add-mask::$URL"

review_comment_url=""
if [ "$EVENT" = "review_completed" ] && [ -n "${TARGET_REPO:-}" ] && [ -n "${ITEM_NUMBER:-}" ]; then
  review_comment_url="$(
    gh api "repos/$TARGET_REPO/issues/$ITEM_NUMBER/comments" --paginate --slurp --jq \
      "[add[] | select(.body | contains(\"<!-- clawsweeper-review item=$ITEM_NUMBER -->\"))] | sort_by(.created_at) | last | .html_url // empty" \
      2>/dev/null || true
  )"
fi

if [ "$EVENT" = "test_ping" ]; then
  payload="$(
    jq -n \
      --arg source clawsweeper \
      --arg event test_ping \
      --arg repo "${TARGET_REPO:-}" \
      --arg head_sha "${HEAD_SHA:-}" \
      --arg run_url "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
      --argjson test true \
      --argjson pr_number "${PR_NUMBER:-null}" \
      '{source: $source, event: $event, test: $test, repo: $repo, pr_number: $pr_number, head_sha: $head_sha, run_url: $run_url}'
  )"
else
  payload="$(
    jq -n \
      --arg source clawsweeper \
      --arg event review_completed \
      --arg repo "${TARGET_REPO:-}" \
      --arg head_sha "${HEAD_SHA:-}" \
      --arg outcome "${OUTCOME:-failure}" \
      --arg review_comment_url "$review_comment_url" \
      --arg run_url "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
      --argjson test false \
      --argjson pr_number "${ITEM_NUMBER:-null}" \
      '{source: $source, event: $event, test: $test, repo: $repo, pr_number: $pr_number, head_sha: $head_sha, outcome: $outcome, review_comment_url: $review_comment_url, run_url: $run_url}'
  )"
fi

set +e
status="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 15 \
    --retry 2 \
    --retry-all-errors \
    -X POST "$URL" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    --data-binary "$payload" \
    2>/dev/null
)"
curl_status=$?
set -e

if [ "$curl_status" -ne 0 ] || [ -z "$status" ]; then
  status=000
fi
echo "ryan-desk webhook HTTP $status"

if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
  echo "::warning::ryan-desk webhook returned HTTP $status"
fi
exit 0
