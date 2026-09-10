#!/usr/bin/env bash
# Generates the Bos Toxic test song with the real ACE-Step model.
#
#   ./scripts/generate-bos-toxic-macos.sh
#
# A thin wrapper: it checks the backend is genuinely answering, then hands over
# to scripts/test-ace-step-bos-toxic.mjs, which is the authoritative smoke test.
# If ACE-Step fails, this fails. It never returns procedural audio.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ace-step-env.sh"

bold "Bos Toxic — real ACE-Step generation"
echo

command -v node >/dev/null 2>&1 || die "Node is needed to run the smoke test."

info "backend       $ACE_STEP_API_URL"
if ! curl -fsS --max-time 5 "$ACE_STEP_API_URL/health" >/dev/null 2>&1; then
  die "The ACE-Step backend is not answering at $ACE_STEP_API_URL.

Start it in another terminal:
  ./scripts/start-ace-step-macos.sh

Then check it:
  ./scripts/diagnose-ace-step-macos.sh

This script will not fall back to the procedural engine: the whole point is to
find out what the neural model produces."
fi
ok "backend answering"
echo

export ACE_STEP_API_URL ACE_STEP_MODEL ACE_STEP_LM_MODEL
exec node "$REPO_ROOT/scripts/test-ace-step-bos-toxic.mjs"
