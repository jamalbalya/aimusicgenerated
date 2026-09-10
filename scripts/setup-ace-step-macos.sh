#!/usr/bin/env bash
# One-time setup for ACE-Step 1.5 on an Apple Silicon Mac.
#
# Follows ACE-Step's own documented installation path (docs/en/INSTALL.md at
# commit ca1e85f): uv as the package manager, `uv sync` for dependencies, and
# `uv run acestep-download` for the weights. It deliberately does not use
# huggingface-cli — that is not what the project currently recommends.
#
#   ./scripts/setup-ace-step-macos.sh
#
# Nothing is downloaded into this repository. See scripts/ace-step-env.sh for
# where things go and how to change it.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ace-step-env.sh"

bold "ACE-Step 1.5 — Apple Silicon setup"
echo

# ---------------------------------------------------------------- 1-3. host ---
bold "1. Machine"
require_apple_silicon
ok "macOS $(sw_vers -productVersion 2>/dev/null || echo 'unknown')"
ok "architecture $(uname -m)"
CHIP="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo 'unknown')"
ok "chip ${CHIP}"
MEM_BYTES="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
ok "memory $(( MEM_BYTES / 1024 / 1024 / 1024 )) GB"
if (( MEM_BYTES / 1024 / 1024 / 1024 < 16 )); then
  warn "ACE-Step wants a good deal of memory; under 16 GB expect to use the smaller LM."
fi
echo

# ------------------------------------------------------------- 4-6. tooling ---
bold "2. Tooling"
if command -v python3 >/dev/null 2>&1; then
  ok "python3 $(python3 -V 2>&1 | awk '{print $2}')"
else
  warn "python3 not found — uv will fetch its own interpreter, which is fine."
fi

if ! command -v uv >/dev/null 2>&1; then
  warn "uv not found — installing it the way ACE-Step documents."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  # The installer puts uv here and prints a line about restarting the shell.
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi
command -v uv >/dev/null 2>&1 || die "uv is still not on PATH. Open a new terminal and run this script again."
ok "uv $(uv --version 2>&1 | awk '{print $2}')"
echo

# ------------------------------------------------------------ 7. the source ---
bold "3. ACE-Step source"
info "location: $ACE_STEP_HOME"
if [[ -d "$ACE_STEP_HOME/.git" ]]; then
  origin="$(git -C "$ACE_STEP_HOME" remote get-url origin 2>/dev/null || echo '')"
  case "$origin" in
    *ACE-Step-1.5*|*ace-step-1.5*) ;;
    *) die "$ACE_STEP_HOME exists but its origin is '$origin', not ACE-Step 1.5.
Move it aside or set ACE_STEP_HOME to somewhere else." ;;
  esac
  info "already cloned — updating"
  git -C "$ACE_STEP_HOME" pull --ff-only || warn "Could not fast-forward; leaving the checkout as it is."
elif [[ -e "$ACE_STEP_HOME" ]]; then
  die "$ACE_STEP_HOME exists and is not a git checkout. Move it aside or set ACE_STEP_HOME."
else
  mkdir -p "$(dirname "$ACE_STEP_HOME")"
  git clone "$ACE_STEP_REPO_URL" "$ACE_STEP_HOME"
fi
ok "commit $(git -C "$ACE_STEP_HOME" rev-parse --short HEAD) on $(git -C "$ACE_STEP_HOME" rev-parse --abbrev-ref HEAD)"
echo

# ----------------------------------------------------------- 8. dependencies ---
bold "4. Dependencies"
info "running 'uv sync' — the first run builds an environment and takes a while"
( cd "$ACE_STEP_HOME" && uv sync ) || die "uv sync failed. The output above says why."
ok "environment ready"
echo

# ---------------------------------------------------------------- 9. models ---
bold "5. Models"
info "location: $ACE_STEP_MODELS"
info "(ACESTEP_CHECKPOINTS_DIR, so the weights sit outside both repositories)"
mkdir -p "$ACE_STEP_MODELS"

# The main bundle carries the turbo DiT, the VAE, the text encoder and the
# 1.7B LM. The 0.6B LM is a separate sub-model and has to be asked for.
info "downloading the main model bundle (~10 GB on first run)"
( cd "$ACE_STEP_HOME" && uv run acestep-download --download-source "$ACE_STEP_DOWNLOAD_SOURCE" ) \
  || die "Model download failed. Try --download-source modelscope if HuggingFace is slow where you are:
  cd $ACE_STEP_HOME && ACESTEP_CHECKPOINTS_DIR=$ACE_STEP_MODELS uv run acestep-download --download-source modelscope"

if [[ "$ACE_STEP_LM_MODEL" != "acestep-5Hz-lm-1.7B" ]]; then
  info "downloading $ACE_STEP_LM_MODEL (not part of the main bundle)"
  ( cd "$ACE_STEP_HOME" && uv run acestep-download --model "$ACE_STEP_LM_MODEL" \
      --download-source "$ACE_STEP_DOWNLOAD_SOURCE" ) \
    || die "Could not download $ACE_STEP_LM_MODEL."
fi
echo

# --------------------------------------------------------- 10-11. verify it ---
bold "6. Verifying the model files"
missing=0
for component in "${ACE_STEP_MAIN_COMPONENTS[@]}"; do
  if ace_step_has_weights "$ACE_STEP_MODELS/$component"; then
    ok "$(printf '%-24s' "$component") $(dir_size "$ACE_STEP_MODELS/$component")"
  else
    bad "$(printf '%-24s' "$component") missing or has no weights"
    missing=$((missing + 1))
  fi
done
if [[ "$ACE_STEP_LM_MODEL" != "acestep-5Hz-lm-1.7B" ]]; then
  if ace_step_has_weights "$ACE_STEP_MODELS/$ACE_STEP_LM_MODEL"; then
    ok "$(printf '%-24s' "$ACE_STEP_LM_MODEL") $(dir_size "$ACE_STEP_MODELS/$ACE_STEP_LM_MODEL")"
  else
    bad "$(printf '%-24s' "$ACE_STEP_LM_MODEL") missing or has no weights"
    missing=$((missing + 1))
  fi
fi
echo
info "total on disk: $(dir_size "$ACE_STEP_MODELS")"
echo

# ------------------------------------------------------------------ 12. MLX ---
bold "7. MLX backend"
if ( cd "$ACE_STEP_HOME" && uv run python -c "import mlx.core, mlx_lm" ) >/dev/null 2>&1; then
  MLX_VERSION="$( cd "$ACE_STEP_HOME" && uv run python -c "import mlx; print(getattr(mlx,'__version__','installed'))" 2>/dev/null || echo installed )"
  ok "MLX available ($MLX_VERSION) — native Apple Silicon acceleration"
else
  warn "MLX did not import. ACE-Step's own launcher repairs this on first start;"
  warn "if it persists, run inside $ACE_STEP_HOME: uv pip install -U mlx mlx-lm"
fi
echo

# ------------------------------------------------------------ 13. diagnosis ---
bold "Result"
if (( missing == 0 )); then
  ok "Setup complete."
  echo
  info "Next:"
  info "  ./scripts/diagnose-ace-step-macos.sh    # check everything at once"
  info "  ./scripts/start-ace-step-macos.sh       # start the API server"
  info "  ./scripts/generate-bos-toxic-macos.sh   # generate the real test song"
else
  bad "$missing model component(s) are missing — ACE-Step will not generate yet."
  info "Re-run this script, or download by hand:"
  info "  cd $ACE_STEP_HOME"
  info "  ACESTEP_CHECKPOINTS_DIR=$ACE_STEP_MODELS uv run acestep-download --all"
  exit 1
fi
