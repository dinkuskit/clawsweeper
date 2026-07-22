#!/usr/bin/env bash
set -euo pipefail

required=(
  CLAWSWEEPER_MODEL_CODEX_HOME
  CLAWSWEEPER_MODEL_GIT_CONFIG
  CLAWSWEEPER_MODEL_HOME
  CLAWSWEEPER_MODEL_PATH
  CLAWSWEEPER_MODEL_USER
  CLAWSWEEPER_PROOF_SCRATCH_DIR
  CLAWSWEEPER_REAL_CODEX
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required" >&2
    exit 2
  fi
done

if [[ ! "$CLAWSWEEPER_MODEL_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  echo "CLAWSWEEPER_MODEL_USER is invalid" >&2
  exit 2
fi
if [[ "$CLAWSWEEPER_REAL_CODEX" != /* || ! -x "$CLAWSWEEPER_REAL_CODEX" ]]; then
  echo "CLAWSWEEPER_REAL_CODEX must be an absolute executable path" >&2
  exit 2
fi
if [[ "$CLAWSWEEPER_MODEL_HOME" != /* || "$CLAWSWEEPER_MODEL_CODEX_HOME" != /* ]]; then
  echo "model home paths must be absolute" >&2
  exit 2
fi
if [[ "$CLAWSWEEPER_MODEL_GIT_CONFIG" != /* || ! -r "$CLAWSWEEPER_MODEL_GIT_CONFIG" ]]; then
  echo "CLAWSWEEPER_MODEL_GIT_CONFIG must be an absolute readable path" >&2
  exit 2
fi
if [[ "$CLAWSWEEPER_PROOF_SCRATCH_DIR" != /* ]]; then
  echo "CLAWSWEEPER_PROOF_SCRATCH_DIR must be absolute" >&2
  exit 2
fi

exec /usr/bin/sudo --non-interactive --set-home --user="$CLAWSWEEPER_MODEL_USER" -- \
  /usr/bin/env -i \
    HOME="$CLAWSWEEPER_MODEL_HOME" \
    CODEX_HOME="$CLAWSWEEPER_MODEL_CODEX_HOME" \
    PATH="$CLAWSWEEPER_MODEL_PATH" \
    CI=true \
    NO_COLOR=1 \
    CLAWSWEEPER_PROOF_SCRATCH_DIR="$CLAWSWEEPER_PROOF_SCRATCH_DIR" \
    GIT_ATTR_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL="$CLAWSWEEPER_MODEL_GIT_CONFIG" \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_OPTIONAL_LOCKS=0 \
    GIT_TERMINAL_PROMPT=0 \
    "$CLAWSWEEPER_REAL_CODEX" "$@"
