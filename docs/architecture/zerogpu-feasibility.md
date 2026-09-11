# Feasibility report: a free remote ACE-Step backend on Hugging Face ZeroGPU

Status: **research only — no code has been changed for this.**

This report answers the seven questions asked before any architectural work
starts. Every claim is labelled. `VERIFIED` means it was read out of a primary
source that this machine could actually fetch, and the source is named.
`UNVERIFIED — DO NOT IMPLEMENT BASED ON ASSUMPTION` means it could not be
confirmed from a primary source and must be measured before any code depends
on it.

## 0. What this environment could and could not read

`huggingface.co`, `hf.co`, `api.huggingface.co`, `*.hf.space` and `gradio.app`
are all blocked by this environment's egress proxy — every `CONNECT` is
answered `403`. So nothing on the Hub itself was opened: not the ZeroGPU docs
page, not the ACE-Step Space, not a live API probe.

What *was* reachable, and is the basis for everything below:

| Source | What it is | Why it counts |
| --- | --- | --- |
| `raw.githubusercontent.com/huggingface/hub-docs/main/docs/hub/spaces-zerogpu.md` | the **source file** that renders as the ZeroGPU docs page | primary |
| `.../hub-docs/main/docs/hub/spaces-overview.md`, `spaces-gpus.md` | Spaces hosting and sleep rules | primary |
| `spaces` **0.51.3** wheel from PyPI (`spaces/zero/client.py`, `spaces/zero/configs.json`) | the actual ZeroGPU client that runs inside a Space | primary, executable |
| `raw.githubusercontent.com/gradio-app/gradio/main/gradio/{routes,route_utils}.py` | Gradio's HTTP routes and CORS middleware | primary |
| `raw.githubusercontent.com/ACE-Step/ACE-Step-1.5/main/{pyproject.toml,requirements.txt,README.md,LICENSE,docs/en/INFERENCE.md}` | the model repo we already integrate | primary |
| `registry.npmjs.org/@gradio/client` | the browser client package | primary |

Reading the docs' *source file* instead of the rendered page is not a
workaround for a paywall or a login — it is the same text, in the repository
Hugging Face publishes it from.

## 1. What current Hugging Face ZeroGPU supports

**VERIFIED** (`hub-docs/docs/hub/spaces-zerogpu.md`):

- Backing hardware is the **NVIDIA RTX Pro 6000 Blackwell**. `large` (the
  default) is half the card, 48 GB VRAM, 1× quota cost. `xlarge` is the full
  card, 96 GB, 2× quota cost.
- **ZeroGPU is compatible with the Gradio SDK only.** Docker and Static Spaces
  cannot schedule onto ZeroGPU.
- Supported Gradio: 4+. Supported PyTorch: 2.8.0, 2.9.1, 2.10.0, 2.11.0,
  2.12.1, 2.13.0. Supported Python: **3.12.12** and **3.10.13** — those two,
  not a range.
- `torch.compile` is not supported.
- **Hosting**: "Free personal accounts: accounts in good standing (verified
  email, account older than 30 days) can host up to 2 ZeroGPU Spaces for free."
- **Daily quota by visitor tier**: unauthenticated **2 minutes**, free account
  **5 minutes**, PRO 40 minutes. "Included daily quota resets exactly 24 hours
  after your first GPU usage."

**VERIFIED** (`spaces` 0.51.3, read from the installed package):

- `DEFAULT_SCHEDULE_DURATION = 60` — an undecorated `@spaces.GPU` requests 60 s
  of quota regardless of how long the work takes.
- `spaces/zero/configs.json` carries a per-GPU `duration_factor`. For the
  **RTX PRO 6000 Blackwell it is `1.5`**, and `get_duration_seconds()` applies
  it whenever `gpu_size != 'xlarge'`. **`@spaces.GPU(duration=120)` on the
  default `large` therefore charges 180 s of quota, not 120 s.** This is not in
  the prose docs anywhere; it came out of the package.
- The pre-check compares *requested* against *remaining*, never actual runtime.
  Failure modes are exactly two: `ZeroGPU illegal duration` (requested exceeds
  the tier's per-call cap — waiting does not help) and `ZeroGPU quota exceeded`
  (remaining < requested, or the runs-per-day cap) with the numbers in the
  message.
- Visitor identity arrives in the **`X-IP-Token`** header. When it is absent,
  `client.py` falls back to **IP-based quotas** and, on exhaustion, raises
  `ZeroGPU quota exceeded` with "Space app has reached its GPU limit."

**UNVERIFIED — DO NOT IMPLEMENT BASED ON ASSUMPTION:**

- The **per-call `duration` cap per tier**. It is enforced server-side; the
  client only sees the rejection. It is deliberately absent from both the hub
  docs and Hugging Face's own ZeroGPU skill. A web-search result reported a
  commit on the official ACE-Step Space titled "fix: lower ZeroGPU duration to
  120s for free-tier users", which suggests the free cap is at or below 120 s —
  but that is a search summary, not a page this machine opened.
- **How `X-IP-Token` is minted.** It is not produced by `@gradio/client`
  (checked: the string does not appear anywhere in the 2.6.0 package), so a
  browser calling a Space cross-origin from our own domain almost certainly
  does **not** carry one. Whether the IP-based fallback then bills the
  *visitor's* IP (2 min each) or a single pooled bucket for the Space is not
  determinable from the client source. **Plan for the pessimistic reading and
  measure.**

## 2. Whether official ACE-Step 1.5 can be used

**Yes — VERIFIED**, and it is the only model we would use.

From `ACE-Step/ACE-Step-1.5`:

- **Licence: MIT** (`LICENSE`, "Copyright (c) 2026 ACEStep"). Deploying it on
  our own Space is permitted.
- `requires-python = ">=3.11,<3.13"`. ZeroGPU offers 3.12.12 and 3.10.13 — so
  **3.12.12 is the only workable pin**, and it must be set explicitly in the
  Space README front-matter or the Space defaults to a Python ACE-Step refuses.
- `gradio==6.2.0` is pinned in ACE-Step's own dependencies: within ZeroGPU's
  "Gradio 4+".
- Linux x86-64 pins `torch==2.10.0+cu128`, which is on ZeroGPU's supported list.
- VRAM: the README states the model "runs locally with less than 4GB of VRAM";
  the XL (4B DiT) variants want ≥12 GB with offload, ≥20 GB without. ZeroGPU
  `large` provides 48 GB, so **even the XL models fit without `xlarge`.**
- There is a documented Python API — `acestep.inference.generate_music` with
  `GenerationParams` / `GenerationConfig`, plus `AceStepHandler` and
  `LLMHandler` (`docs/en/INFERENCE.md`). A Space wrapper calls these; it does
  not need ACE-Step's FastAPI server.

**One real build obstacle, VERIFIED**: `requirements.txt` contains a bare
`flash-attn; sys_platform == 'linux' and platform_machine == 'x86_64'` and a
`nano-vllm` installed from a local path. Hugging Face's own ZeroGPU guidance
states that the ZeroGPU **build** phase has no `nvcc` (the base image is
`python:3.13`), so a CUDA package distributed only as an sdist — bare
`flash-attn` is the example they name — **cannot be installed from
`requirements.txt` on ZeroGPU**. The Space therefore cannot use ACE-Step's
stock requirements unmodified. This is a known problem with two known fixes:
pin a pre-built `flash-attn` wheel URL matching cp312 × cu12 × torch 2.10, or
drop `flash-attn`/`nano-vllm` and run the LM on the `pt` backend, which the
ACE-Step README already lists as the recommended backend for the 0.6B LM. It is
work, not a blocker.

## 3. Whether the official ACE-Step Space can be called programmatically

**UNVERIFIED — DO NOT IMPLEMENT BASED ON ASSUMPTION.**

An official Space is linked from the ACE-Step 1.5 README as
`https://huggingface.co/spaces/ACE-Step/Ace-Step-v1.5`, so it exists. But this
machine cannot open it, which means **its `api_name`s, its input signature, its
output signature and whether its API is exposed at all are all unknown.** I
will not guess them; inventing a Gradio function name is exactly the failure
mode you ruled out.

What *is* verified is the transport it would use, straight from Gradio's source:

- `gradio/route_utils.py:87` — `API_PREFIX = "/gradio_api"`.
- `gradio/routes.py:1496` — `POST /gradio_api/call/{api_name}`, body
  `{"data": [...]}`, responding `{"event_id": "..."}`.
- `gradio/routes.py:1589` — `GET /gradio_api/call/{api_name}/{event_id}`, the
  SSE stream that carries the result.

And CORS, which decides whether a GitHub Pages origin can call a Space at all —
`gradio/route_utils.py`, `CustomCORSMiddleware.is_valid_origin()`:

```python
return (
    host_name not in self.localhost_aliases
    or origin_name in self.localhost_aliases
)
```

A Space's host is `*.hf.space`, which is not a localhost alias, so the
condition is true for **every** origin and Gradio echoes back
`Access-Control-Allow-Origin: <origin>`. **At the Gradio layer, a browser on
`jamalbalya.github.io` may call a Space cross-origin.** Whether Hugging Face's
own edge proxy in front of `*.hf.space` adds a stricter policy is
**UNVERIFIED** — `*.hf.space` is blocked here, so it cannot be probed. This is
the single cheapest thing to test first, and it is testable in ten seconds from
any unblocked browser.

Even if the official Space *is* callable, depending on it is the wrong
architecture: its owners can rename a function, set `api_open=False`, pause it,
or change its model defaults, and our app breaks with no warning and no
recourse. It also runs on *their* hosting budget.

## 4. Whether a custom Space is required

**Yes — recommended, for three reasons, two of them verified:**

1. We define our own `api_name` and signature, so nothing is guessed. (Removes
   the entire unknown in §3.)
2. We control the `@spaces.GPU(duration=...)` estimate. That is not cosmetic:
   because the pre-check is *requested vs remaining*, a wrong duration is the
   difference between a visitor getting a song and getting
   `ZeroGPU quota exceeded` on their first click.
3. We can fix the `flash-attn` build problem from §2 in our own
   `requirements.txt`.

The hosting cost is zero, and the gate is explicit in the docs: **the Hugging
Face account must have a verified email and be more than 30 days old**, and it
may host at most 2 ZeroGPU Spaces. Note the related line in
`spaces-overview.md`: "creating a Space that runs on compute (Gradio or Docker)
requires a paid plan, while Static Spaces are free for everyone." Read together
with the ZeroGPU page, ZeroGPU is the *exception* that stays free for free
accounts — which is also what the Hub forum thread "New free accounts cannot
create CPU Basic Gradio Spaces (only ZeroGPU available?)" reports. So the free
path runs through ZeroGPU specifically, not through a CPU Space.

## 5. Expected limitations for full-song generation

This is the part that decides what the product can honestly promise, so here is
the arithmetic in full. Quota charged on `large` is `declared_duration × 1.5`
(VERIFIED above).

| Visitor | Daily quota | Max declarable `duration` that can ever clear the pre-check | Calls/day at `duration=60` (90 s charged) |
| --- | --- | --- | --- |
| Unauthenticated | 120 s | 80 s | **1** |
| Free HF account | 300 s | 200 s | **3** |
| PRO | 2400 s | — | ~26 |

And our visitors are, as far as can be determined, **unauthenticated**: the
`X-IP-Token` that identifies a signed-in Hugging Face user is not something a
page on our own domain can mint (§1).

So the honest expectation for the public site is **on the order of one song per
visitor per day**, not unlimited generation. That is a product constraint, not
a bug, and the UI has to say so plainly rather than let someone hit a wall.

Two further limits, both VERIFIED:

- **Sleep.** `spaces-gpus.md`: "Spaces running on free hardware are suspended
  automatically if they are not used for an extended period of time (e.g. two
  days)"; a visitor restarts it automatically. ACE-Step's weights are ~11 GB,
  and ZeroGPU wants models placed on `cuda` at module scope during startup, so
  the **first request after a cold start will be slow** — minutes, plausibly —
  and that wait is *not* charged to GPU quota but is charged to the visitor's
  patience.
- **Disk.** `spaces-overview.md`: 16 GB RAM, 2 CPU cores, 50 GB non-persistent
  disk by default. ~11 GB of weights fits, but nothing about that disk is
  promised to survive a restart.

**UNVERIFIED — DO NOT IMPLEMENT BASED ON ASSUMPTION: how long ACE-Step 1.5
actually takes on half an RTX Pro 6000.** The ACE-Step README claims "under 2
seconds per full song on an A100 and under 10 seconds on an RTX 3090" — that is
a vendor claim, it describes the DiT decode and not the LM "thinking" stage we
enable for vocal tracks, and nobody here has run it. Your own proven local
result is a **271-second song on an M2**, which says nothing about Blackwell
throughput. **Every number in the table above assumes a `duration` we have not
yet earned the right to declare.** The first thing implementation must do is
measure one real generation on the Space and set the estimator from that
measurement.

## 6. Exact recommended architecture

```
GitHub Pages (jamalbalya.github.io/aimusicgenerated)   ← unchanged, still the public frontend
        │
        │  VITE_MUSIC_PROVIDER = local | remote        ← explicit, never automatic
        │
        ├─ local  → AceStepProvider      → http://127.0.0.1:8001   (the Mac, dev/test only)
        └─ remote → AceStepRemoteProvider → https://<space>.hf.space
                                             POST /gradio_api/call/<our api_name>   → {event_id}
                                             GET  /gradio_api/call/<our api_name>/<event_id>  (SSE)
```

- **Space**: Gradio SDK, ZeroGPU hardware, `python_version: "3.12.12"`, owned
  by your Hugging Face account. One `app.py` that imports
  `acestep.inference.generate_music` and exposes exactly one handler with a
  stable `api_name` we choose, returning the audio file plus a metadata object
  carrying the model ids actually used.
- **Duration**: `@spaces.GPU(duration=estimator)` where the estimator is a
  callable of the request (song length, model, thinking on/off), calibrated
  from a measured run — never a static 120.
- **Provider**: `AceStepRemoteProvider` implements the existing
  `MusicGenerationProvider` interface, so `StudioPage` does not learn a third
  code path. It reuses `verifyLyricsPreserved()`, the model-substitution guard
  and `checkWavBuffer()` unchanged: the remote backend gets exactly the same
  distrust the local one does.
- **Configuration**: `VITE_ACE_STEP_SPACE_URL`, supplied at build time the same
  way `VITE_ACE_STEP_API_URL` already is. A public Space URL is not a secret,
  but it is not hardcoded either — no URL, no username, no token in the source.
- **No silent fallback, unchanged**: the remote provider throws
  `EngineUnavailableError` on every failure, and `tests/unit/no-fallback.test.ts`
  gets the remote provider added to the same spy harness that already proves
  the local one can never reach `ProceduralVocalRenderer`.
- **Free-tier honesty in the UI**: `ZeroGPU quota exceeded` and
  `ZeroGPU illegal duration` are distinct, first-class states with the real
  message shown (it contains the actual seconds and the reset time), not a
  generic "generation failed". Default to one take, because each extra
  candidate is another full quota charge.

Cost: **$0.** No paid API, no paid GPU, no AWS/GCP/Azure/RunPod/Vast/Replicate,
no change of model, no procedural downgrade, and the Mac stays development-only.

## 7. Blockers

Nothing here is architecturally impossible. There are three gates, and none of
them can be cleared from this machine:

1. **Hugging Face account eligibility.** Hosting a free ZeroGPU Space requires
   a verified email and an account older than 30 days. If the account is newer
   than 30 days, the free path is closed until it ages — and no amount of code
   changes that.
2. **`*.hf.space` CORS at the edge.** Gradio itself permits our origin
   (verified from source). Hugging Face's proxy in front of it is unverified
   and unprobeable from here. If it blocks cross-origin browser calls, the
   direct browser→Space design is dead and the fallback is embedding the Space
   as an iframe — which also happens to restore per-visitor quota via
   `X-IP-Token`, at the cost of showing ACE-Step's UI instead of ours.
3. **The throughput ceiling is a product decision, not a technical one.**
   Roughly one song per visitor per day for anonymous visitors. That is what
   free costs. It needs your explicit acceptance before it is worth building
   the UI around it.

**Verdict: technically viable, worth building, and stopping here** — per the
instruction to stop before architectural changes when a blocker exists. Gates 1
and 3 are yours; gate 2 is one browser console command away from being settled.
