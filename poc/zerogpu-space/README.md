---
title: ACE-Step 1.5 Full-Song POC
emoji: 🎤
colorFrom: red
colorTo: indigo
sdk: gradio
sdk_version: 6.2.0
python_version: "3.12.12"
app_file: app.py
startup_duration_timeout: 1h
short_description: Measures whether free ZeroGPU can render a whole 271s song
---

# ACE-Step 1.5 full-song POC

One question: can free ZeroGPU render the whole Bos Toxic song — 271 seconds,
Indonesian, male vocal, vocal and instrumental together — in a single request?

Not an application. One function, one API name, defaults fixed to the fixture.

## Access

This Space refuses anonymous callers. Every path that costs GPU time or hands
back a result — `/queue/join`, `/queue/data`, `/call/*`, `/run/*`, `/api/*` and
`/file=*` — requires an `Authorization: Bearer <hugging face token>` header. The
token is verified against Hugging Face on this side of the wire, and the
verified username is then checked against an allowlist. Nothing in the request
body is ever read as identity.

Set these as **Space secrets**, not as repository variables:

| secret | meaning |
| --- | --- |
| `ALLOWED_HF_USERS` | Who may generate. Comma or space separated. **Unset means nobody** — the Space fails closed. |
| `OPENID_PROVIDER_URL` | Optional. Where identity is checked; defaults to `https://huggingface.co`. |
| `AUTH_CACHE_SECONDS` | Optional, default 60. How long a verified token is trusted before Hugging Face is asked again — also how long a revoked one keeps working. |
| `RATE_LIMIT_REQUESTS` / `RATE_LIMIT_WINDOW_SECONDS` | Optional abuse brake per user, default 6 per hour. In process memory: it resets whenever the Space restarts, and it is not the ZeroGPU quota. |

Because the gate applies to the queue as well, **the Space's own web UI will not
generate** — there is no browser session to carry a bearer. That is intended:
this Space is an API for the studio, and it was always a measuring harness
rather than something to use directly.

## Why the front-matter says what it says

| key | value | why this value and no other |
| --- | --- | --- |
| `sdk` | `gradio` | ZeroGPU schedules Gradio Spaces only. Docker and Static Spaces cannot reach it. |
| `python_version` | `3.12.12` | ZeroGPU offers 3.12.12 and 3.10.13. ACE-Step requires `>=3.11,<3.13`. The intersection is one version. |
| `sdk_version` | `6.2.0` | ACE-Step pins `gradio==6.2.0`; ZeroGPU supports Gradio 4+. |
| `startup_duration_timeout` | `1h` | The default is 30 minutes and startup downloads roughly 11 GB of checkpoints. |

**ZeroGPU hardware is not set here.** There is no front-matter key for it — the
valid `suggested_hardware` flavors are the dedicated GPUs. Select ZeroGPU in
*Settings → Hardware* after creating the Space.

## Deploying

Requires a Hugging Face account with a verified email, older than 30 days, which
is what free ZeroGPU hosting asks for. Free accounts may host two such Spaces.

```bash
./deploy.sh <your-hf-username>/<space-name>
```

It creates nothing on Hugging Face by itself — create the Space in the web UI
with SDK *Gradio* and hardware *ZeroGPU* first, then run the script. It copies
`app.py`, `requirements.txt`, this README and the fixtures, vendors ACE-Step 1.5
at a pinned commit under `vendor/`, records that commit in `vendor/COMMIT.txt`,
and pushes. It never pushes weights or audio.

### What the vendored ACE-Step tree excludes, and why

Hugging Face rejected the first push over binary assets in the upstream tree, so
`deploy.sh` now prunes it before `git add` and refuses to push if anything binary
survives.

Removed wholesale — verified by grep that no `.py` file under `acestep/` or
`openrouter/` references either path:

| removed | why |
| --- | --- |
| `assets/` | 9 PNG, 1 GIF, 1 SVG of README artwork. `star.gif` alone is 2.9 MB |
| `docs/` | the VitePress documentation site: 81 markdown files and 12 JPG screenshots under `docs/pics/` |
| `.git/` | replaced by `vendor/COMMIT.txt`, which records the exact upstream SHA |
| every top-level dot directory | upstream CI, hooks and tooling configuration. Never imported |

Then a tree-wide sweep by extension — images, video, design sources, documents,
archives and fonts — which is what catches
`acestep/third_parts/nano-vllm/assets/logo.png`, the one binary that lives inside
the Python package rather than in a documentation directory. It is by extension
rather than by path deliberately: an upstream release that adds a screenshot
somewhere new is handled without anyone editing this script.

Finally `verify_vendor` walks every remaining file and **aborts the deploy** if
any is binary (non-empty and not text) or larger than 10 MiB. The extension
sweep knows about media we have seen; this catches what it has not, and stops
rather than discovering the problem in a rejected push. `ALLOW_BINARY_VENDOR=1`
overrides it for a file that genuinely belongs, and `MAX_VENDOR_FILE_BYTES`
moves the size threshold.

**Nothing runtime is touched.** Measured against the real upstream tree: all 613
`.py` files survive byte-identically, as do `acestep/genres_vocab.txt` (4.8 MB,
the largest file in the repo and plain text) and the two JavaScript files
ACE-Step force-includes in its wheel. The tree goes from 31 MB to 14 MB, and the
24 images — about 6.2 MB — are the entire difference in binary content.

One caveat worth stating: the largest binary upstream is 2.9 MB and **no file
exceeds 10 MiB**, so a plain "files over 10 MB need Git LFS" rule is not what
rejected that push. The likeliest mechanism is the Space's default
`.gitattributes` marking these extensions for Git LFS on a machine where
`git lfs install` has not been run. Removing the files fixes it either way, but
if a push still fails, the verbatim remote error is the thing to look at.

## Running the test

```bash
python3 run_test.py https://<user>-<space>.hf.space
```

Writes `zerogpu-run-<timestamp>.json` next to itself and, on success, the WAV.
Neither belongs in git.

## What was changed from stock ACE-Step, and why

- **ACE-Step is vendored as source, not pip-installed.** Its dependency list
  contains a bare `flash-attn` sdist. The ZeroGPU build phase has no `nvcc`, so
  that cannot compile. Putting the source on `sys.path` gets the library without
  handing its dependency list to the resolver. `requirements.txt` then states
  every runtime dependency explicitly.
- **`use_flash_attention=False`.** Not a workaround: it is `initialize_service`'s
  own default. Stated explicitly so the question does not come up again.
- **LM backend `pt`, not `vllm`.** vLLM arrives through `nano-vllm`, which is
  installed from a local path and wants flash-attn. `pt` is ACE-Step's universal
  fallback and what its README recommends alongside the 0.6B LM. This is the one
  change that could plausibly cost real time, and the measurement will say so.
- **`batch_size=1`.** ACE-Step's `GenerationConfig` defaults to 2, which would
  double the GPU bill for a test that needs one song.
- **`use_cot_caption=False`, `use_cot_lyrics=False`, `use_cot_language=False`.**
  All three default to letting the language model rewrite the caption, the lyric
  sheet, or the stated language. The caption and the lyric sheet are the user's,
  and the language was stated.
- **`torch` from PyPI rather than `download.pytorch.org`.** Same 2.10.0 release,
  on ZeroGPU's supported list, one less index in a build that cannot be debugged
  interactively.

Nothing else differs. Same model, same LM, same lyrics, same style, same 271
seconds.

## The substitution guard

ACE-Step's `DEFAULT_LM_MODEL` is the **1.7B**, and the 1.7B ships inside the main
checkpoint repo — so it is already on disk beside the 0.6B we asked for. Any
silent fallback lands on it.

So `app.py` fetches `acestep-5Hz-lm-0.6B` explicitly before initialising, and
`verify_models()` runs at startup *and* again on every request, reading back
ACE-Step's own records: `last_init_params["config_path"]` for the DiT, and
`_lm_full_model_path` — the resolved on-disk path — for the LM. A mismatch
raises. The resolved path is the one that matters: a request for the 0.6B that
quietly resolved to the 1.7B would still echo back the name it was asked for.
