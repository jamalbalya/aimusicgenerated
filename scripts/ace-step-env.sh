#!/usr/bin/env bash
# Shared configuration for the ACE-Step scripts.
#
# Sourced by setup / diagnose / start / generate so there is one place that
# decides where things live. Every value can be overridden from the environment
# or from a .env file at the root of this repository, so nothing here is tied to
# one person's machine.
#
#   ACE_STEP_HOME        where the ACE-Step source is cloned
#   ACE_STEP_MODELS      where the model weights live (ACESTEP_CHECKPOINTS_DIR)
#   ACE_STEP_API_URL     the address the studio and the smoke test talk to
#   ACE_STEP_MODEL       DiT checkpoint
#   ACE_STEP_LM_MODEL    5 Hz language model
#
# Weights are deliberately kept outside both this repository and the ACE-Step
# clone: they are ~10 GB, they are not source, and keeping them in their own
# directory means updating or re-cloning ACE-Step never re-downloads them.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Expands a leading ~ the way a shell would. Values read out of a .env file are
# not expanded by anything, so "~/Models/..." would otherwise be taken as a
# directory literally named "~".
expand_tilde() {
  case "$1" in
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s' "$HOME/${1#\~/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# A .env in this repository may set any of these; the real environment wins.
#
# Written for bash 3.2, which is what macOS still ships as /bin/bash: no
# associative arrays, and no ${!name:-} indirection.
if [[ -f "$REPO_ROOT/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *=* ]] && continue
    key="${line%%=*}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    # Only our own variables, and only plain identifiers: this value reaches an
    # eval below, and anything else has no business being there.
    [[ "$key" =~ ^(ACE_STEP|ACESTEP)_[A-Z0-9_]+$ ]] || continue
    eval "current=\${$key-}"
    [[ -n "$current" ]] && continue
    value="${line#*=}"
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    export "$key=$(expand_tilde "$value")"
  done < "$REPO_ROOT/.env"
fi

ACE_STEP_HOME="$(expand_tilde "${ACE_STEP_HOME:-$HOME/Applications/ACE-Step-1.5}")"
ACE_STEP_MODELS="$(expand_tilde "${ACE_STEP_MODELS:-$HOME/Models/ACE-Step-1.5}")"
ACE_STEP_HOST="${ACE_STEP_HOST:-127.0.0.1}"
ACE_STEP_PORT="${ACE_STEP_PORT:-8001}"
ACE_STEP_API_URL="${ACE_STEP_API_URL:-http://${ACE_STEP_HOST}:${ACE_STEP_PORT}}"
ACE_STEP_MODEL="${ACE_STEP_MODEL:-acestep-v15-turbo}"
ACE_STEP_LM_MODEL="${ACE_STEP_LM_MODEL:-acestep-5Hz-lm-0.6B}"
ACE_STEP_REPO_URL="${ACE_STEP_REPO_URL:-https://github.com/ACE-Step/ACE-Step-1.5.git}"
ACE_STEP_DOWNLOAD_SOURCE="${ACE_STEP_DOWNLOAD_SOURCE:-auto}"

# ACE-Step reads this to find its weights, which is what keeps them out of the
# clone. Exported for every child process the scripts start.
export ACESTEP_CHECKPOINTS_DIR="$ACE_STEP_MODELS"

# The components that arrive with the main model bundle. Checked by name so a
# half-finished download is reported as missing rather than as ready.
ACE_STEP_MAIN_COMPONENTS=(
  "acestep-v15-turbo"
  "vae"
  "Qwen3-Embedding-0.6B"
  "acestep-5Hz-lm-1.7B"
)

# Files that mean "this directory actually contains weights", from ACE-Step's
# own _contains_model_weights().
ACE_STEP_WEIGHT_FILES=(
  "model.safetensors"
  "model.safetensors.index.json"
  "pytorch_model.bin"
  "pytorch_model.bin.index.json"
  "diffusion_pytorch_model.safetensors"
  "diffusion_pytorch_model.safetensors.index.json"
  "diffusion_pytorch_model.bin"
  "diffusion_pytorch_model.bin.index.json"
)

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }

die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# True when a model directory holds at least one real weights file.
ace_step_has_weights() {
  local dir="$1" file
  [[ -d "$dir" ]] || return 1
  for file in "${ACE_STEP_WEIGHT_FILES[@]}"; do
    [[ -f "$dir/$file" ]] && return 0
  done
  return 1
}

# Fails unless this really is an Apple Silicon Mac.
require_apple_silicon() {
  [[ "$(uname -s)" == "Darwin" ]] || die "This script is for macOS. This machine reports $(uname -s)."
  local arch; arch="$(uname -m)"
  [[ "$arch" == "arm64" ]] || die "This script needs Apple Silicon (arm64). This machine reports $arch.
CUDA is not required and is not used here, but an Intel Mac cannot run the MLX backend."
}

# Human-readable size of a directory, or a dash when it is not there.
dir_size() {
  [[ -d "$1" ]] && du -sh "$1" 2>/dev/null | cut -f1 || echo "—"
}
