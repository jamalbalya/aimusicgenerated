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

# Documentation media. Extensions rather than paths, so an upstream release that
# adds a new screenshot somewhere new is handled without editing this script.
# None of these can be part of an audio model's inference path, and a grep of
# the ACE-Step package confirms no runtime code reads assets/ or docs/.
BINARY_ASSET_EXTS=(
  png jpg jpeg gif webp bmp tif tiff ico svg avif heic       # images
  mp4 mov avi webm mkv m4v                                    # video
  psd ai sketch fig xcf                                       # design sources
  pdf docx pptx xlsx odt odp ods                              # documents
  zip tar tgz gz bz2 xz 7z rar                                # archives
  ttf otf woff woff2 eot                                      # fonts
)

# Directories that hold nothing but documentation. Removed wholesale rather than
# swept, because their markdown and vitepress scaffolding is dead weight in a
# Space too. Verified against the upstream tree: no .py file under acestep/ or
# openrouter/ references "assets/" or "docs/".
DOC_ONLY_DIRS=(docs assets)

# Repository metadata that is never imported at runtime.
METADATA_DIRS=(.git .github .githooks .claude)

prune_vendor() {
  local root="$1" removed=0 before after
  before=$(find "$root" -type f | wc -l | tr -d ' ')

  local d
  for d in "${METADATA_DIRS[@]}" "${DOC_ONLY_DIRS[@]}"; do
    if [[ -e "$root/$d" ]]; then
      echo "    - removing $d/"
      rm -rf "${root:?}/${d:?}"
    fi
  done

  # Sweep the rest of the tree by extension. This is what catches assets nested
  # inside the package itself, such as third_parts/nano-vllm/assets/logo.png.
  # Seeded with -false so every term can be appended as "-o -iname ...", which
  # avoids having to unset a trailing -o afterwards. Both GNU and BSD find take
  # -false, and the Mac this is run from has BSD find.
  local find_args=(-false) ext
  for ext in "${BINARY_ASSET_EXTS[@]}"; do
    find_args+=(-o -iname "*.${ext}")
  done

  while IFS= read -r -d '' f; do
    echo "    - removing ${f#"$root"/}"
    rm -f "$f"
    removed=$((removed + 1))
  done < <(find "$root" -type f \( "${find_args[@]}" \) -print0)

  # Directories left empty by the sweep serve no purpose in the Space.
  find "$root" -type d -empty -delete

  after=$(find "$root" -type f | wc -l | tr -d ' ')
  echo "    pruned: $before files -> $after files ($removed swept by extension)"
}

# The backstop. The sweep above knows about media we have seen; this catches
# anything binary we have not, and stops rather than pushing it. A push that
# Hugging Face rejects costs a round trip; a deploy that refuses to start says
# exactly which file is the problem.
verify_vendor() {
  local root="$1" offenders=() f size
  local max_bytes="${MAX_VENDOR_FILE_BYTES:-10485760}"   # Hugging Face asks for Git LFS above 10 MiB

  while IFS= read -r -d '' f; do
    size=$(wc -c < "$f" | tr -d ' ')
    # An empty file is not binary; several of ACE-Step's __init__.py are empty
    # and grep -I would otherwise report them.
    if (( size > 0 )) && ! grep -Iq . "$f" 2>/dev/null; then
      offenders+=("binary  $(printf '%8d' "$size")  ${f#"$root"/}")
    elif (( size > max_bytes )); then
      offenders+=("oversize $(printf '%8d' "$size")  ${f#"$root"/}")
    fi
  done < <(find "$root" -type f -print0)

  if (( ${#offenders[@]} > 0 )); then
    if [[ "${ALLOW_BINARY_VENDOR:-}" == "1" ]]; then
      echo "    WARNING: binary/oversize files kept because ALLOW_BINARY_VENDOR=1:"
      printf '      %s\n' "${offenders[@]}"
      return 0
    fi
    echo >&2
    echo "ERROR: the vendored tree still contains files Hugging Face is likely to reject:" >&2
    printf '  %s\n' "${offenders[@]}" >&2
    echo >&2
    echo "Add the extension to BINARY_ASSET_EXTS if it is documentation media." >&2
    echo "If the file is genuinely needed at runtime, re-run with ALLOW_BINARY_VENDOR=1" >&2
    echo "and arrange Git LFS for it." >&2
    exit 1
  fi
  echo "    verified: no binary or oversize files remain in the vendored tree"
}

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
# guard.py is the security boundary: app.py imports it, so a deploy that
# left it behind would not start at all.
cp "$HERE/app.py" "$HERE/guard.py" "$HERE/requirements.txt" "$HERE/README.md" "$WORK/space/"
mkdir -p "$WORK/space/fixtures"
cp "$HERE/fixtures/bos-toxic-style.txt" "$HERE/fixtures/bos-toxic-lyrics.txt" "$WORK/space/fixtures/"

echo "==> vendoring ACE-Step 1.5 at $ACE_STEP_REF (source only)"
rm -rf "$WORK/space/vendor"
mkdir -p "$WORK/space/vendor"
VENDOR_DIR="$WORK/space/vendor/ACE-Step-1.5"
git clone --depth 1 --branch "$ACE_STEP_REF" "$ACE_STEP_REPO" "$VENDOR_DIR"
ACE_SHA="$(git -C "$VENDOR_DIR" rev-parse HEAD)"
rm -rf "$VENDOR_DIR/.git"
printf '%s %s\n' "$ACE_STEP_REPO" "$ACE_SHA" > "$WORK/space/vendor/COMMIT.txt"
echo "    pinned at $ACE_SHA"

prune_vendor "$VENDOR_DIR"
verify_vendor "$VENDOR_DIR"

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
