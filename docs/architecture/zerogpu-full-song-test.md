# ZeroGPU full-song test — ACE-Step 1.5, Bos Toxic, 271 seconds

## Verdict

> ## PASS — full-song generation validated on the live Space, 2026-09-11

The project owner deployed this POC and ran the Bos Toxic request on it. As
reported by them:

| | Result |
|---|---|
| Space | `Jamalbalya/aimusicgenerated`, API host `https://jamalbalya-aimusicgenerated.hf.space` |
| Hardware | ZeroGPU `large` — RTX PRO 6000 Blackwell Server Edition, MIG 2g.48GB |
| Models | `acestep-v15-turbo`, `acestep-5Hz-lm-0.6B`, PyTorch/CUDA |
| Request | the Bos Toxic style and all 68 lyric lines, `id`, male, sung, 271 s |
| Output | **one complete 271-second WAV from one request**, 48 kHz, stereo, 16-bit |
| Generation time | about 44.7 s, inside the Space's 80 s declared GPU duration |
| Chunking | none |
| Out of memory | no |
| Quality | subjectively better than the local Mac run |

Measured by the Space itself on that run (`run_test.py`'s record of it is kept
out of git; the metadata is in `tests/unit/fixtures/zerogpu/real-run-metadata.json`,
where a test checks the studio accepts it):

| | Value |
|---|---|
| GPU | NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb, 47.38 GB, CUDA 12.8, torch 2.10.0+cu128 |
| Loaded | `acestep-v15-turbo`; `acestep-5Hz-lm-0.6B` from `…/checkpoints/acestep-5Hz-lm-0.6B`; LM backend `pt` |
| Startup (outside the GPU budget) | DiT and main model 19.7 s, language model 25.4 s |
| Generation, inside the 80 s GPU call | LM 36.3 s · DiT diffusion 1.9 s (8 steps × 0.23 s) · VAE decode 3.2 s · **44.7 s total** |
| Client wall clock, submit to finished | 47.7 s |
| Audio | 271.0 s, 48 kHz, 2 channels, 16-bit, 52,032,044 bytes, peak 0.89 |
| Echoed back | 68 lyric lines, `id`, not instrumental, seed 101390300 |
| Result stream | three heartbeats, then `complete` |

Checked independently the same day, read-only and at no GPU cost:

| | How | Result |
|---|---|---|
| Endpoint contract | `GET /gradio_api/info` | `/generate_music` = style, lyrics, language, vocal_gender (`male`/`female`/`mixed`), instrumental, duration (integer) → audio file, metadata string |
| Deployed code | the endpoint's defaults against the repository | identical to `poc/zerogpu-space` and the Bos Toxic fixture |
| Gradio | `GET /config` | 6.2.0, protocol `sse_v3`, prefix `/gradio_api`, `generate_music` at fn_index 0, public |
| CORS | `curl` with `Origin: https://jamalbalya.github.io`, on every route the studio's client uses | `access-control-allow-origin: https://jamalbalya.github.io` on `GET /config`, the `OPTIONS` preflight for `POST /gradio_api/queue/join` (POST and `content-type` allowed), `GET /gradio_api/queue/data`, and `GET /gradio_api/file=` — the last even on a refused (403) request, so the page can read failures as well as successes |

**Still unverified**, and not to be read as covered by the PASS above:

- a generation driven from a real browser on the GitHub Pages origin — CORS was
  checked at the header level with curl, not observed in a browser, and the
  studio's queue-protocol client has been tested against a fake built from the
  live Space's contract, not against the Space;
- which quota identity an anonymous browser visitor is charged under, and how
  much one full song actually consumes (§10 and §12 below were never measured);
- any song length other than 271 seconds, on this Space's 80-second GPU budget.

The integration into the studio is described in `neural-generation.md`.

---

## The first attempt: BLOCKED

What follows is the record from before the owner's run, kept as it was written.
The build environment it describes could not reach Hugging Face at all.

```
$ curl -sS -o /dev/null -w '%{http_code}\n' --max-time 15 https://huggingface.co/api/whoami-v2
curl: (56) CONNECT tunnel failed, response 403
000
```

The same `403` on `CONNECT` comes back for `hf.co`, `api.huggingface.co`,
`*.hf.space` and `endpoints.huggingface.cloud`. The proxy's own guidance for
this class of failure is explicit: *"The destination host is not allowed by your
organization's egress policy for this session. Do not retry or route around it —
report the blocked host."* There are also no Hugging Face credentials in this
environment (`env | grep -i HF_` is empty), no `hf` or `huggingface-cli` on the
path, no `huggingface_hub` installed, no browser, and no GPU.

So a Space could not be created, could not be pushed to, could not be started,
could not be called, and no WAV exists. Under the task's own rule — *"PASS
requires an actual generated WAV"* — the only honest verdict is BLOCKED.

**What exists instead:** the entire proof of concept, built and checked, ready to
deploy and run. It lives in `poc/zerogpu-space/`. Phases 1 through 5 are done as
artefacts; phases 6 through 9 are measurements that need a machine that can
reach Hugging Face. Section 16 is the runbook.

---

## 1. Space URL

**NOT CREATED.** Deploying requires `huggingface.co`, which is blocked.

It will be `https://huggingface.co/spaces/<user>/<space>`, with the API host
`https://<user>-<space>.hf.space`. Record both here after deployment.

Prerequisite, from the ZeroGPU documentation: hosting a free ZeroGPU Space needs
an account "in good standing (verified email, account older than 30 days)", and
a free account may host two.

## 2. Space configuration

`poc/zerogpu-space/README.md` carries the Space card. Front-matter, with the
reason each value is the only possible one:

| key | value | why |
| --- | --- | --- |
| `sdk` | `gradio` | ZeroGPU schedules Gradio Spaces only — Docker and Static cannot reach it |
| `python_version` | `3.12.12` | ZeroGPU offers 3.12.12 and 3.10.13; ACE-Step requires `>=3.11,<3.13`. One version satisfies both |
| `sdk_version` | `6.2.0` | ACE-Step pins `gradio==6.2.0`; ZeroGPU supports Gradio 4+ |
| `app_file` | `app.py` | — |
| `startup_duration_timeout` | `1h` | default is 30 minutes; startup downloads ~11 GB of checkpoints |

**Hardware is not in the front-matter.** There is no ZeroGPU value for
`suggested_hardware` — the valid flavors are the dedicated GPUs. ZeroGPU is
selected in *Settings → Hardware* after the Space exists. That step is manual
and cannot be scripted from the repository.

## 3. API name

`generate_music`, ours to define rather than guessed from anyone else's Space.

Verified against the current Gradio contract rather than assumed:
`gradio/events.py` still takes `api_name: str | None = None` on event listeners
("defines how the endpoint appears in the API docs"), and `gradio/routes.py`
registers `POST /gradio_api/call/{api_name}` returning `{"event_id": ...}` and
`GET /gradio_api/call/{api_name}/{event_id}` as the SSE result stream, with
`API_PREFIX = "/gradio_api"` in `gradio/route_utils.py`.

Signature, in order: `style, lyrics, language, vocal_gender, instrumental,
duration` → `(audio, metadata_json)`.

## 4. Dependency configuration

The flash-attn problem is solved by not letting pip see ACE-Step's dependency
list at all. ACE-Step is **vendored as source** under `vendor/ACE-Step-1.5` and
put on `sys.path`; `requirements.txt` then states every runtime dependency
explicitly. Nothing sdist-only and CUDA-dependent is ever asked to build.

Every change from stock, and why:

| change | reason |
| --- | --- |
| ACE-Step vendored, not pip-installed | its dependency list contains a bare `flash-attn` sdist, and the ZeroGPU build phase has no `nvcc` |
| `flash-attn` dropped | not needed: `initialize_service` takes `use_flash_attention` and **defaults it to `False`**. `app.py` passes `False` explicitly |
| `nano-vllm`, `triton` dropped | only the vLLM LM backend needs them. We run `backend="pt"`, ACE-Step's own universal fallback and its README's recommendation alongside the 0.6B LM |
| `mlx`, `mlx-lm`, `triton-windows`, the Windows flash-attn wheel | other platforms |
| `lightning`, `tensorboard`, `lycoris-lora` dropped | LoRA training only. `peft` is **kept**, because `LoraManagerMixin` is part of the handler class |
| `spaces` not pinned | the platform pins its own; a pin here fails the build |
| `torch==2.10.0` from PyPI, not `2.10.0+cu128` from `download.pytorch.org` | same release, on ZeroGPU's supported list, one less index in a build that cannot be debugged interactively |
| `torchao>=0.16.0,<0.17.0` | kept exactly as ACE-Step pins it — unpinned it resolves to 0.18.x, which imports a torch symbol the pinned torch lacks |

Every version was checked to exist on PyPI before being written down: `torch`
2.10.0 ✓, `torchaudio` 2.10.0 ✓, `torchvision` 0.25.0 ✓, `torchao` 0.16.0 ✓,
`gradio` 6.2.0 ✓.

**Untested, and honestly so:** whether this set is *complete*. It was assembled
by reading ACE-Step's manifests, not by running a build — no build is possible
here. A missing transitive import is exactly the kind of thing the first real
deploy discovers, and if it happens the fix is to add the package, not to
reconsider the approach.

## 5. GPU information

**NOT MEASURED.** `app.py` records `gpu_name`, `gpu_memory_bytes`,
`gpu_memory_gb`, `cuda_version`, `torch_version` and compute `capability` from
`torch.cuda` inside the GPU call.

From the ZeroGPU documentation, for comparison once real values exist: the
backing card is an NVIDIA RTX Pro 6000 Blackwell; `large` is half of it with
48 GB, `xlarge` the whole card with 96 GB at double the quota cost.

## 6. Model information

Requested: `acestep-v15-turbo`. Unchanged from the proven local baseline.

It is one of `MAIN_MODEL_COMPONENTS` in ACE-Step's downloader, so it arrives
with the main checkpoint repo `ACE-Step/Ace-Step1.5` — no separate fetch.

**Loaded model: NOT MEASURED.**

## 7. LM information

Requested: `acestep-5Hz-lm-0.6B`, backend `pt`.

**This is where substitution would happen, and it is not hypothetical.** In
`acestep/model_downloader.py`:

```python
DEFAULT_LM_MODEL = "acestep-5Hz-lm-1.7B"

MAIN_MODEL_COMPONENTS = [
    "acestep-v15-turbo",
    "vae",
    "Qwen3-Embedding-0.6B",
    "acestep-5Hz-lm-1.7B",     # Default LM model (1.7B)
]
```

The 1.7B is the default **and** ships inside the main repo, so it is already on
disk next to the 0.6B. The 0.6B is a separate submodel
(`ACE-Step/acestep-5Hz-lm-0.6B`). Anything that quietly falls back lands on the
1.7B, with no error and no missing file to notice.

Two defences, both in `app.py`:

1. `ensure_lm_model("acestep-5Hz-lm-0.6B", ...)` runs before initialisation, so
   the requested LM is present rather than merely requested.
2. `verify_models()` runs at startup **and again on every request**, reading back
   ACE-Step's own records — `last_init_params["config_path"]` for the DiT, and
   `_lm_full_model_path`, the *resolved on-disk path*, for the LM. It raises on
   any mismatch, and separately on `"1.7B" in lm_path`. The resolved path is the
   one that matters: a request for the 0.6B that resolved to the 1.7B would still
   echo back the name it was asked for.

**Loaded LM: NOT MEASURED.**

## 8. Actual generation time

**NOT MEASURED.** Recorded by `app.py` as `model_load_time_s`, `LM_load_time_s`,
`lm_download_time_s`, `total_generation_time_s`, `total_request_time_s`, plus
ACE-Step's own `time_costs` dict verbatim — its `lm_*` and `dit_*` keys and
`pipeline_total_time`, copied rather than re-derived, so no stage name is
guessed. `run_test.py` adds client-side `wall_clock_s`.

No estimate is offered here. The earlier survey extrapolated ~25 GPU-seconds
from an illustrative table in ACE-Step's `BENCHMARK.md`; that was labelled an
extrapolation then and it is not evidence now.

## 9. Actual audio duration

**NOT MEASURED.** Requested `audio_duration = 271`, passed through untouched.
ACE-Step's `API.md` documents the range as 10–600 seconds in one request, so
271 is an ordinary single request, not a stretch.

Two independent readings will be recorded: `audio_duration_s` from the returned
tensor inside the Space, and `check_wav()` in `run_test.py`, which parses the
RIFF chunks of the downloaded file and computes duration from `data` chunk size
and format — it trusts nothing the Space claimed.

## 10. Quota consumed

**NOT MEASURED.**

What the declared duration will be, and the arithmetic behind it:
`DECLARED_DURATION` defaults to **80** on `large`. The `spaces` client multiplies
the declared value by the backing GPU's `duration_factor` — 1.5 for the RTX Pro
6000 Blackwell, in `spaces/zero/configs.json` — before the scheduler sees it. So
80 declared is 120 requested, which is the largest value a reported 120-second
free-tier per-call ceiling can accept. Daily quotas are 2 minutes
unauthenticated and 5 minutes for a free account.

**All of that is documentation, and documentation is what this phase exists to
stop trusting.** The run must record: the declared duration, the actual GPU time,
the quota actually charged (read from the numbers inside a deliberate second
call's `ZeroGPU quota exceeded` message, which states "Xs requested vs. Ys
left"), whether the request was accepted, whether it completed, and whether
output came back.

## 11. CORS result

**NOT MEASURED.** No browser here, and `*.hf.space` is blocked.

`poc/zerogpu-space/cors-test.html` is the probe. It must be served from
`https://jamalbalya.github.io` for the answer to mean anything — `file://` sends
`Origin: null` and tests nothing, and curl is not a browser and does not enforce
the same-origin policy at all. It checks four things separately: the OPTIONS
preflight, the POST, the SSE stream, and the audio fetch. It sends a 10-second
instrumental rather than the fixture, because a transport check should not spend
a meaningful slice of a two-minute daily quota.

What is already known, from source rather than guesswork:
`CustomCORSMiddleware.is_valid_origin()` in `gradio/route_utils.py` returns
`host_name not in self.localhost_aliases or origin_name in self.localhost_aliases`.
A Space's host is `*.hf.space`, never a localhost alias, so Gradio echoes
`Access-Control-Allow-Origin` for every origin. **Whether Hugging Face's own edge
proxy in front of `*.hf.space` is stricter is exactly what the probe is for.**

## 12. Public access result

**NOT MEASURED.** Three runs needed: signed-in browser, private window, and the
GitHub Pages origin.

What to record: authentication required, API token required, `X-IP-Token`
present, which quota identity was charged, and whether public invocation worked
at all.

The expectation to test against — and it is only an expectation — is that our
visitors are billed as **unauthenticated**. `spaces/zero/client.py` identifies a
visitor from an `X-IP-Token` header and falls back to IP-based quota without one,
and that string appears nowhere in `@gradio/client` 2.6.0. If a real request
turns out to carry one, the per-visitor budget is five minutes rather than two,
and the throughput answer changes.

## 13. WAV validation result

**NOT MEASURED.** Validated twice, deliberately in two places.

In the Space: `wav_sample_rate`, `wav_channels`, `wav_bytes`, `peak_level` from
the returned tensor. On the client: `check_wav()` re-parses the RIFF header,
walks the chunks, and derives duration from the `data` chunk — so a file that is
truncated, silent, or not a WAV at all fails there even if the Space said it was
fine. That validator was exercised here against a synthetic 2-second WAV
(reported 2.0 s, 48 kHz, 2 channels) and against 32 bytes of garbage (rejected,
"not a RIFF/WAVE file"), so it is known not to pass everything.

A generation that returns silence is a failure. `peak_level` is in the metadata
for that reason.

## 14. Exact errors

One, and it is the whole story:

```
CONNECT huggingface.co:443 -> 403 (policy denial)
CONNECT hf.co:443 -> 403
CONNECT api.huggingface.co:443 -> 403
CONNECT *.hf.space:443 -> 403
```

No Hugging Face credentials, no `hf` CLI, no `huggingface_hub`, no browser, no
GPU. Nothing was attempted and silently swallowed; nothing could be attempted.

No ZeroGPU duration limit was hit, no dependency failure observed, no model
loading failure, no quota refusal, no CORS failure, no authentication failure, no
runtime termination, and no ACE-Step incompatibility — because none of those
stages was ever reached. Recording them as "passed" would be a lie of omission.

## 15. PASS criteria

| | criterion | status |
| --- | --- | --- |
| ⬜ | $0 | POC uses only free ZeroGPU. **Not executed.** |
| ✅ | No Mac server | the Mac appears nowhere in this POC |
| ⬜ | ACE-Step 1.5 | vendored from the official repo. **Not executed.** |
| ⬜ | Turbo | `acestep-v15-turbo` requested and verified at runtime. **Not executed.** |
| ⬜ | 0.6B LM | fetched explicitly and guarded twice. **Not executed.** |
| ⬜ | One generation request | one `generate_music` call. **Not executed.** |
| ⬜ | Full 271-second song | `audio_duration=271`, never shortened. **Not executed.** |
| ⬜ | Vocal | `thinking=True`, male gender in the caption. **Not executed.** |
| ⬜ | Instrumental | same generation, same request. **Not executed.** |
| ⬜ | Indonesian | `vocal_language="id"`, `use_cot_language=False`. **Not executed.** |
| ✅ | Exact lyrics | fixture copied byte-for-byte from `tests/unit/fixtures/`; `cmp` clean; sha256 `7f879d57…aad025`; 68 lyric lines + 12 section tags confirmed by count |
| ⬜ | Output WAV valid | validator built and proven non-vacuous. **No WAV exists.** |
| ⬜ | Public/remote access | **Not executed.** |
| ⬜ | GitHub Pages CORS | probe built. **Not executed.** |
| ✅ | No paid service | nothing in this POC costs anything |
| ✅ | Does not violate HF terms | a public ZeroGPU Space invoked by public visitors is the documented purpose |
| ⬜ | No model substitution | guard written and placed. **Not executed.** |

Three green, and only the three that are properties of the artefacts rather than
of a run. Everything else waits on a machine that can reach Hugging Face.

## 16. Runbook — what to do on a machine that can reach Hugging Face

1. Create the Space in the web UI: SDK **Gradio**, then *Settings → Hardware →
   **ZeroGPU***.
2. `cd poc/zerogpu-space && ./deploy.sh <user>/<space>`
   Copies the app, requirements, card and fixtures; clones ACE-Step 1.5 at a
   pinned commit into `vendor/` and records the SHA in `vendor/COMMIT.txt`;
   pushes. No weights, no audio.
3. Watch the build. A missing transitive dependency shows up here — add it to
   `requirements.txt` and push again.
4. Watch the first start: ~11 GB of checkpoints download, which is why
   `startup_duration_timeout` is `1h`. Startup fails loudly if the 0.6B LM is
   not what got loaded.
5. `python3 run_test.py https://<user>-<space>.hf.space`
   Writes `zerogpu-run-<timestamp>.json` and the WAV. **Paste the JSON into
   sections 5–10 and 13 of this document, replacing every "NOT MEASURED".**
6. Immediately run it a second time and capture the `ZeroGPU quota exceeded`
   message verbatim — it states requested-versus-remaining, which is the only
   direct reading of what the first call actually cost. That goes in §10.
7. Copy `cors-test.html` into the site's `public/`, deploy, open it at
   `https://jamalbalya.github.io/aimusicgenerated/cors-test.html`, run it
   signed-in and again in a private window, paste the summary into §11 and §12,
   then remove the file. It is deliberately not part of the application.
8. Replace the verdict at the top with PASS or FAIL on the evidence.

Do not commit the WAV or the run JSON — `.gitignore` in the pushed Space covers
the Space side; keep the client-side artefacts out of this repository too.

## Appendix — deliverables

| file | what it is |
| --- | --- |
| `poc/zerogpu-space/app.py` | the Space: one GPU function, `api_name="generate_music"`, full instrumentation, substitution guard |
| `poc/zerogpu-space/requirements.txt` | curated dependencies, every deviation annotated |
| `poc/zerogpu-space/README.md` | the Space card and the rationale for every front-matter value |
| `poc/zerogpu-space/deploy.sh` | vendors ACE-Step at a pinned commit and pushes; never pushes weights |
| `poc/zerogpu-space/run_test.py` | runs the real test over the raw Gradio HTTP contract, validates the WAV independently, records failures as results |
| `poc/zerogpu-space/cors-test.html` | browser CORS probe for the GitHub Pages origin |
| `poc/zerogpu-space/fixtures/` | the Bos Toxic style and lyrics, byte-identical to `tests/unit/fixtures/` |
| `poc/zerogpu-space/metadata-template.json` | the shape of the metadata JSON, all values null because no run has happened |

**No generated WAV, because no generation happened.** The metadata JSON is a
template with null values rather than a result, for the same reason.

Nothing in `src/` was touched. The provider architecture is unchanged.
