#!/usr/bin/env bash
# Push this POC to a Hugging Face Space.
#
# Create the Space in the web UI first — SDK Gradio, hardware ZeroGPU — then run
# this. It only pushes files; it creates nothing and buys nothing.
#
# Weights and generated audio never go near this: the Space downloads its own
# checkpoints at startup, and .gitignore keeps run artefacts out.
set -euo pipefail

ACE_STEP_REPO="${ACE_STEP_REPO:-https://github.com/ACE-Step/ACE-Step-1.5.git}"
# Pin whatever the operator resolves at deploy time. Left empty deliberately:
# inventing a commit hash would be worse than recording a real one.
ACE_STEP_REF="${ACE_STEP_REF:-main}"

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <hf-user>/<space-name>" >&2
  echo "  e.g. $0 jamalbalya/acestep-fullsong-poc" >&2
  exit 2
fi
SPACE_ID="$1"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> cloning Space $SPACE_ID"
git clone "https://huggingface.co/spaces/$SPACE_ID" "$WORK/space"

echo "==> copying POC files"
cp "$HERE/app.py" "$HERE/requirements.txt" "$HERE/README.md" "$WORK/space/"
mkdir -p "$WORK/space/fixtures"
cp "$HERE/fixtures/bos-toxic-style.txt" "$HERE/fixtures/bos-toxic-lyrics.txt" "$WORK/space/fixtures/"

echo "==> vendoring ACE-Step 1.5 at $ACE_STEP_REF (source only)"
rm -rf "$WORK/space/vendor"
mkdir -p "$WORK/space/vendor"
git clone --depth 1 --branch "$ACE_STEP_REF" "$ACE_STEP_REPO" "$WORK/space/vendor/ACE-Step-1.5"
ACE_SHA="$(git -C "$WORK/space/vendor/ACE-Step-1.5" rev-parse HEAD)"
rm -rf "$WORK/space/vendor/ACE-Step-1.5/.git"
printf '%s %s\n' "$ACE_STEP_REPO" "$ACE_SHA" > "$WORK/space/vendor/COMMIT.txt"
echo "    pinned at $ACE_SHA"

cat > "$WORK/space/.gitignore" <<'GI'
checkpoints/
*.wav
*.flac
*.mp3
zerogpu-run-*.json
GI

echo "==> pushing"
cd "$WORK/space"
git add -A
git -c user.name="${GIT_AUTHOR_NAME:-jamalbalya}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-jamal.balya@gmail.com}" \
    commit -m "ACE-Step 1.5 full-song POC (ACE-Step @ ${ACE_SHA:0:12})" || {
      echo "nothing to commit"; exit 0; }
git push

echo
echo "Pushed. Now, in the Space UI:"
echo "  1. Settings -> Hardware -> ZeroGPU  (there is no front-matter key for it)"
echo "  2. Wait for the build, then the ~11 GB checkpoint download on first start"
echo "  3. python3 run_test.py https://$(echo "$SPACE_ID" | tr '/' '-' | tr '[:upper:]' '[:lower:]').hf.space"
echo
echo "ACE-Step commit vendored: $ACE_SHA"
