#!/usr/bin/env bash
# Starts the ACE-Step 1.5 API server on Apple Silicon, with the MLX backend.
#
#   ./scripts/start-ace-step-macos.sh
#
# Runs in the foreground; Ctrl-C stops it. There is no fallback: if ACE-Step
# cannot start, this exits non-zero and says why. It never quietly leaves you
# with the procedural engine — that is a choice made in the studio, not a
# silent substitution made here.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ace-step-env.sh"

bold "Starting ACE-Step 1.5"
echo

# ------------------------------------------------------------- preconditions ---
require_apple_silicon
ok "Apple Silicon ($(uname -m))"

[[ -d "$ACE_STEP_HOME/.git" ]] \
  || die "ACE-Step is not installed at $ACE_STEP_HOME.
Run ./scripts/setup-ace-step-macos.sh first."
ok "ACE-Step at $ACE_STEP_HOME ($(git -C "$ACE_STEP_HOME" rev-parse --short HEAD))"

command -v uv >/dev/null 2>&1 || die "uv is not on PATH. Open a new terminal, or re-run the setup script."

missing=()
for component in "${ACE_STEP_MAIN_COMPONENTS[@]}"; do
  ace_step_has_weights "$ACE_STEP_MODELS/$component" || missing+=("$component")
done
if [[ "$ACE_STEP_LM_MODEL" != "acestep-5Hz-lm-1.7B" ]]; then
  ace_step_has_weights "$ACE_STEP_MODELS/$ACE_STEP_LM_MODEL" || missing+=("$ACE_STEP_LM_MODEL")
fi
if (( ${#missing[@]} > 0 )); then
  die "These model components are missing from $ACE_STEP_MODELS:
  ${missing[*]}
Run ./scripts/setup-ace-step-macos.sh, or download them by hand:
  cd $ACE_STEP_HOME && ACESTEP_CHECKPOINTS_DIR=$ACE_STEP_MODELS uv run acestep-download --all"
fi
ok "models present in $ACE_STEP_MODELS ($(dir_size "$ACE_STEP_MODELS"))"

if lsof -nP -iTCP:"$ACE_STEP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "Something is already listening on port $ACE_STEP_PORT.
If it is an older ACE-Step, stop it first; otherwise set ACE_STEP_PORT to another port."
fi
echo

# -------------------------------------------------------------------- launch ---
# ACE-Step reads both of these; exporting them is how the 0.6B LM and the shared
# weights directory are selected without editing the upstream launcher.
export ACESTEP_CHECKPOINTS_DIR="$ACE_STEP_MODELS"
export ACESTEP_LM_MODEL_PATH="$ACE_STEP_LM_MODEL"
export ACESTEP_LM_BACKEND="mlx"
export TOKENIZERS_PARALLELISM="false"

info "DiT model     $ACE_STEP_MODEL"
info "LM model      $ACE_STEP_LM_MODEL"
info "backend       MLX (Apple Silicon)"
info "checkpoints   $ACE_STEP_MODELS"
bold "API           $ACE_STEP_API_URL"
info "docs          $ACE_STEP_API_URL/docs"
echo
info "The first request loads the models and takes several minutes."
info "Leave this running. Ctrl-C to stop."
echo

cd "$ACE_STEP_HOME" || die "Could not enter $ACE_STEP_HOME"

# On the documented port, use ACE-Step's own macOS launcher: it also checks and
# repairs the MLX packages against the running macOS version. On any other port
# call the entry point directly, because that launcher hardcodes 8001.
if [[ "$ACE_STEP_PORT" == "8001" && -x "./start_api_server_macos.sh" ]]; then
  info "using ACE-Step's own start_api_server_macos.sh"
  exec ./start_api_server_macos.sh
fi

info "starting acestep-api on port $ACE_STEP_PORT"
exec uv run acestep-api --host "$ACE_STEP_HOST" --port "$ACE_STEP_PORT" \
  --lm-model-path "$ACE_STEP_LM_MODEL"
