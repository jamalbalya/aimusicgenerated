#!/usr/bin/env bash
# Reports whether ACE-Step can actually generate a song on this machine.
#
#   ./scripts/diagnose-ace-step-macos.sh
#
# READY means every one of: Apple Silicon, ACE-Step installed, the models on
# disk, the server listening, and /health answering. Anything less is NOT READY
# with the reason. Configuration alone never counts as ready.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ace-step-env.sh"
# A diagnostic reports every problem rather than stopping at the first, and it
# must not itself abort on an empty array — bash 3.2, which macOS still ships,
# treats "${empty[@]}" under `set -u` as an unbound variable.
set +e
set +u

problems=()
note() { problems+=("$1"); }

bold "ACE-Step 1.5 — diagnostics"
echo

# ------------------------------------------------------------------- machine ---
bold "Machine"
OS="$(uname -s)"
ARCH="$(uname -m)"
if [[ "$OS" == "Darwin" ]]; then
  ok "OS            macOS $(sw_vers -productVersion 2>/dev/null || echo '?')"
else
  bad "OS            $OS (these scripts target macOS)"
  note "not macOS"
fi
if [[ "$ARCH" == "arm64" ]]; then
  ok "architecture  arm64"
else
  bad "architecture  $ARCH (MLX needs Apple Silicon)"
  note "not Apple Silicon"
fi
info "chip          $(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo '?')"
MEM_GB=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 / 1024 / 1024 ))
info "RAM           ${MEM_GB} GB"
echo

# ------------------------------------------------------------------- tooling ---
bold "Tooling"
if command -v python3 >/dev/null 2>&1; then
  ok "Python        $(python3 -V 2>&1 | awk '{print $2}')"
else
  warn "Python        not on PATH (uv supplies its own)"
fi
if command -v uv >/dev/null 2>&1; then
  ok "uv            $(uv --version 2>&1 | awk '{print $2}')"
else
  bad "uv            not installed"
  note "uv is not installed — run ./scripts/setup-ace-step-macos.sh"
fi
echo

# ----------------------------------------------------------------- ACE-Step ---
bold "ACE-Step"
info "location      $ACE_STEP_HOME"
if [[ -d "$ACE_STEP_HOME/.git" ]]; then
  ok "commit        $(git -C "$ACE_STEP_HOME" rev-parse --short HEAD 2>/dev/null || echo '?')"
  VERSION="$(grep -m1 '^version' "$ACE_STEP_HOME/pyproject.toml" 2>/dev/null | cut -d'"' -f2)"
  info "version       ${VERSION:-unknown}"
  if ( cd "$ACE_STEP_HOME" && uv run python -c "import mlx.core, mlx_lm" ) >/dev/null 2>&1; then
    ok "MLX           available"
  else
    warn "MLX           not importable (the macOS launcher tries to repair this)"
  fi
else
  bad "not installed at $ACE_STEP_HOME"
  note "ACE-Step is not installed — run ./scripts/setup-ace-step-macos.sh"
fi
echo

# ------------------------------------------------------------------- models ---
bold "Models"
info "location      $ACE_STEP_MODELS"
model_missing=0
for component in "${ACE_STEP_MAIN_COMPONENTS[@]}"; do
  if ace_step_has_weights "$ACE_STEP_MODELS/$component"; then
    ok "$(printf '%-24s' "$component") $(dir_size "$ACE_STEP_MODELS/$component")"
  else
    bad "$(printf '%-24s' "$component") missing"
    model_missing=$((model_missing + 1))
  fi
done
if [[ "$ACE_STEP_LM_MODEL" != "acestep-5Hz-lm-1.7B" ]]; then
  if ace_step_has_weights "$ACE_STEP_MODELS/$ACE_STEP_LM_MODEL"; then
    ok "$(printf '%-24s' "$ACE_STEP_LM_MODEL") $(dir_size "$ACE_STEP_MODELS/$ACE_STEP_LM_MODEL")"
  else
    bad "$(printf '%-24s' "$ACE_STEP_LM_MODEL") missing (requested LM)"
    model_missing=$((model_missing + 1))
  fi
fi
info "total         $(dir_size "$ACE_STEP_MODELS")"
(( model_missing > 0 )) && note "$model_missing model component(s) missing"
echo

# ---------------------------------------------------------------- the server ---
bold "Server"
info "API           $ACE_STEP_API_URL"
info "port          $ACE_STEP_PORT"
if lsof -nP -iTCP:"$ACE_STEP_PORT" -sTCP:LISTEN >/dev/null 2>&1 \
   || nc -z "$ACE_STEP_HOST" "$ACE_STEP_PORT" >/dev/null 2>&1; then
  ok "port $ACE_STEP_PORT     listening"
else
  bad "port $ACE_STEP_PORT     nothing listening"
  note "the API server is not running — run ./scripts/start-ace-step-macos.sh"
fi

HEALTH="$(curl -fsS --max-time 5 "$ACE_STEP_API_URL/health" 2>/dev/null)"
if [[ -n "$HEALTH" ]]; then
  ok "/health       responded"
  # Parsed with node rather than sed: this is JSON, BSD and GNU sed disagree
  # about the escapes a pattern like this needs, and the repository already
  # requires node for everything else.
  read_field() {
    if command -v node >/dev/null 2>&1; then
      printf '%s' "$HEALTH" | node -e '
        let raw = ""
        process.stdin.on("data", (chunk) => { raw += chunk })
        process.stdin.on("end", () => {
          try {
            const envelope = JSON.parse(raw)
            const health = envelope && envelope.data ? envelope.data : envelope
            const value = health[process.argv[1]]
            process.stdout.write(value === null || value === undefined ? "" : String(value))
          } catch { process.stdout.write("") }
        })' "$1"
    else
      printf ''
    fi
  }
  if command -v node >/dev/null 2>&1; then
    info "service       $(read_field service) $(read_field version)"
    info "models loaded $(read_field models_initialized)"
    info "LM loaded     $(read_field llm_initialized)"
    LOADED_MODEL="$(read_field loaded_model)"
    LOADED_LM="$(read_field loaded_lm_model)"
    info "DiT in use    ${LOADED_MODEL:-none yet (loaded on first request)}"
    info "LM in use     ${LOADED_LM:-none yet (loaded on first request)}"
    # A loaded model that is not the requested one is the substitution ACE-Step
    # performs by itself; see acestep/api/startup_llm_init.py.
    if [[ -n "$LOADED_LM" && "$LOADED_LM" != "$ACE_STEP_LM_MODEL" ]]; then
      bad "LM mismatch   requested $ACE_STEP_LM_MODEL, backend loaded $LOADED_LM"
      note "the backend substituted the language model"
    fi
    if [[ -n "$LOADED_MODEL" && "$LOADED_MODEL" != "$ACE_STEP_MODEL" ]]; then
      bad "DiT mismatch  requested $ACE_STEP_MODEL, backend loaded $LOADED_MODEL"
      note "the backend substituted the generation model"
    fi
  else
    warn "node not found, so the /health body was not parsed"
  fi
else
  bad "/health       no response"
  note "/health did not answer at $ACE_STEP_API_URL"
fi
echo

# ------------------------------------------------------------------- verdict ---
if (( ${#problems[@]} == 0 )); then
  printf '\033[1;32m%s\033[0m\n' "READY"
  info "ACE-Step is installed, the models are on disk, and the backend is answering."
  info "Next: ./scripts/generate-bos-toxic-macos.sh"
  exit 0
fi
printf '\033[1;31m%s\033[0m\n' "NOT READY"
for problem in "${problems[@]}"; do bad "$problem"; done
exit 1
