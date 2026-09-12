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

**This Space is public.** Nobody signs in, no credential is read, and the web UI
here works like any other Space's. Anyone can generate.

What makes that safe to leave open is not a door but a ceiling: ZeroGPU's own
quota. A request that would exceed the account's free GPU allowance is refused by
Hugging Face before any GPU starts, so an open Space cannot run up a bill. There
is nothing to pay for and nothing to leak — no key, no model weight and no
private data lives here.

What is still enforced on every request, signed in or not:

- **Input validation** — style, lyrics, language, voice, the instrumental flag
  and the length are all checked for shape and size before a handler runs
  (`guard.validate_request`). An oversized lyric sheet or a length outside
  10–600 seconds is refused without touching the GPU.
- **Rate limiting** — every caller is counted, and a caller over the limit gets a
  429 (`guard.RateLimiter`). With nobody signed in the caller is their forwarded
  IP address, which the client can write, so this is a brake on casual
  repetition rather than a security control. The quota above is the real
  ceiling.
- **Path policy** — only the paths a client genuinely needs are served.

### Making it private instead

Two Space **secrets** — not repository variables — turn the sign-in back on:

| secret | meaning |
| --- | --- |
| `ALLOWED_HF_USERS` | The guest list: who may generate. Comma or space separated. Naming anyone here makes the Space private, and then an `Authorization: Bearer <hugging face token>` header is required on every path that costs GPU time or hands back a result — `/queue/join`, `/queue/data`, `/call/*`, `/run/*`, `/api/*`, `/file=*`. The token is verified against Hugging Face on this side of the wire; nothing in the request body is ever read as identity. |
| `REQUIRE_HF_SIGN_IN` | `1` demands a sign-in even with no guest list named — which, failing closed, admits nobody. `0` keeps the Space public even when a guest list exists. Unset lets the guest list decide, so neither mode is ever reached by accident. |
| `OPENID_PROVIDER_URL` | Optional. Where identity is checked; defaults to `https://huggingface.co`. |
| `AUTH_CACHE_SECONDS` | Optional, default 60. How long a verified token is trusted before Hugging Face is asked again — also how long a revoked one keeps working. |
| `RATE_LIMIT_REQUESTS` / `RATE_LIMIT_WINDOW_SECONDS` | Optional abuse brake per caller, default 6 per hour. Applies in **both** modes. In process memory: it resets whenever the Space restarts, and it is not the ZeroGPU quota. |

In private mode everything fails closed: an empty guest list authorises nobody,
and a Hugging Face that cannot be reached authorises nobody either. It also means
**the Space's own web UI will not generate**, because there is no browser session
to carry a bearer — the studio frontend, which holds an OAuth token, is then the
only way in.

`poc/zerogpu-space/test_guard.py` covers both modes (`python3 test_guard.py`, no
dependencies), and `live_boundary_test.py --public` probes a deployed one over
real HTTP without spending GPU time.

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
`app.py`, `guard.py`, `requirements.txt`, this README and the fixtures — `app.py`
imports `guard.py`, so a deploy that left it behind would not start — vendors
ACE-Step 1.5
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
