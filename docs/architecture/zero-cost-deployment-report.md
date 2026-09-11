# $0 FULL-SONG DEPLOYMENT REPORT

Status: **research only. No application code was changed, no provider was
implemented, the ACE-Step integration is untouched.**

---

## 0. Read this first: two corrections to the brief's premises

### 0.1 "A 60–120 second demo is NOT acceptable" — ZeroGPU's 120 s is not a clip length

The brief treats Hugging Face ZeroGPU's 120-second figure as a limit on how
long the *song* can be. It is not. `@spaces.GPU(duration=N)` declares how many
seconds of **GPU compute** the call may occupy. It says nothing about the
duration of the audio that compute produces.

The distinction decides this whole report, and both halves of it are verified:

- **ACE-Step 1.5 generates 10–600 seconds of audio in one request.**
  `docs/en/API.md` line 189: `audio_duration | float | null | Generation
  duration (seconds), range 10-600`. The README says the same: "Supports 10
  seconds to 10 minutes (600s) audio generation". A 271-second song, or a
  5-minute one, is a single ordinary request to this model. No chunking.
- **ACE-Step is a diffusion model whose compute cost tracks diffusion steps,
  not wall-clock output length.** The README claims "under 2 seconds per full
  song on an A100 and under 10 seconds on an RTX 3090".

So the real question is not "can ZeroGPU make a long song" — the model makes
long songs in one shot by design. It is "does a 271-second song's *compute*
fit inside the free per-call ceiling". That is a measurement, and §3 says why
nobody here could take it.

### 0.2 Nothing in this report was executed

No generation was run on any provider. This environment has no GPU, and its
egress proxy answers `403` to `CONNECT` for `huggingface.co`, `*.hf.space`,
`colab.research.google.com`, `research.google.com`, `kaggle.com`,
`lightning.ai`, `modal.com` and `replicate.com` — I could not even open their
documentation, let alone sign in and run a job. Per the brief's own rule, no
provider below is described as having produced a full song, because none was
asked to.

**Source discipline used throughout.** Three labels, applied per claim:

- **PRIMARY-READ** — fetched and read in full from the vendor's own repository
  or package here. These are the claims you can act on.
- **CORROBORATED** — the vendor's own page, quoted through the search index,
  with more than one independent result agreeing. Good, not conclusive.
- **UNVERIFIED** — do not implement based on it.

What was reachable and therefore PRIMARY-READ: `huggingface/hub-docs` (the
source files that render as the ZeroGPU and Spaces docs pages), the `spaces`
0.51.3 wheel from PyPI (the actual ZeroGPU client), `gradio` source, the
`ACE-Step/ACE-Step-1.5` repository including `API.md`, `BENCHMARK.md`,
`INFERENCE.md`, `pyproject.toml`, `requirements.txt` and `LICENSE`, and the
`@gradio/client` npm package.

---

## 1. Comparison matrix

Transposed — one column per provider — because twenty-two attributes do not fit
across a page. **Dev** = usable for development compute. **Prod** = usable as
the public API behind GitHub Pages.

| | **HF ZeroGPU Space** | **Colab Free** | **Kaggle** | **Lightning Free** | **Modal Starter** | **Free serverless APIs** (Groq / Cerebras / CF Workers AI) | **Official ACE-Step hosted** | **Community ACE-Step Space** |
|---|---|---|---|---|---|---|---|---|
| **Cost** | $0 | $0 | $0 | $0 + credits | $30/mo credits | $0 | paid per second | $0 (someone else's) |
| **GPU** | RTX Pro 6000 Blackwell | T4 typical, not guaranteed | P100 / 2×T4 | T4 and up, credit-priced | T4→H100 | n/a — no custom models | n/a | RTX Pro 6000 |
| **VRAM** | 48 GB (`large`) / 96 GB (`xlarge`) | ~16 GB | 16 GB / 2×16 GB | varies | varies | n/a | n/a | 48 GB |
| **Max runtime** | per-call GPU cap, free tier ~120 s | ~12 h session | ~12 h session | Studio free 4 h then billed | no hard cap | per-request | n/a | ~120 s |
| **Daily/weekly quota** | 2 min/day anon, 5 min/day free acct | "dynamic", undisclosed | ~30 GPU-h/week | 15 credits/mo (~22 T4-h) | $30/mo | request/neuron caps | n/a | same as ZeroGPU |
| **Can run ACE-Step 1.5?** | **Yes** (see §2) | Yes | Yes | Yes | Yes | **No** | Yes (theirs) | Yes |
| **Custom Python deps?** | Yes, w/ CUDA-wheel caveat | Yes | Yes | Yes | Yes | **No** | n/a | n/a |
| **Can run Gradio?** | **Required** — Gradio SDK only | Yes (tunnelled) | Awkward | Yes | Yes | No | n/a | Yes |
| **Can expose HTTP API?** | **Yes**, `/gradio_api/call/…` | only via tunnel | only via tunnel | only while Studio awake | **Yes**, native | Yes (theirs) | Yes | Yes |
| **Callable remotely?** | Yes | technically, but see terms | technically, but see terms | while awake | Yes | Yes | Yes | Yes |
| **GitHub Pages can call it?** | **Yes** (CORS verified in Gradio source) | n/a — barred by terms | n/a — barred in practice | not durably | Yes, CORS configurable | Yes | Yes | Yes |
| **CORS** | automatic, any origin | n/a | n/a | manual | manual | permissive | n/a | automatic |
| **Auth required** | none for a public Space | Google account, interactive | Kaggle account | account | token | API key | API key | none |
| **Idle timeout** | sleeps after ~2 days idle | ~90 min idle | ~1 h interactive | 4 h then billed | scale-to-zero | n/a | n/a | ~2 days |
| **Cold start** | minutes (~11 GB weights) | minutes + install | minutes + install | minutes | seconds–minutes | none | none | minutes |
| **Concurrent users** | node-level queue | 1 (yours) | 1 (yours) | 1 Studio | 10 concurrent GPUs | high | high | queue |
| **Public users can trigger?** | **Yes — the intended use** | **No** | **No** | No | Yes | Yes | Yes | Yes |
| **Full 3-min song?** | model supports it; **compute UNMEASURED** | yes | yes | yes | yes | **no** | yes | probably |
| **Full 5-min song?** | same, model ceiling is 600 s | yes | yes | yes | yes | **no** | yes | probably |
| **Violates free-tier terms?** | **No** | **YES for production** | **Yes in practice** | No, but not durable | No | No | No | Freeloading |
| **Suspension risk** | Low | **High if used as a backend** | **High if tunnelled** | Low | Low | Low | n/a | their Space, not yours |
| **Verdict** | **Only production candidate** | **DEV ONLY** | **DEV ONLY** | **DEV ONLY** | **Excluded — card required** | **Excluded — cannot run ACE-Step** | **Excluded — paid** | **Excluded — not ours** |

---

## 2. Per-provider findings

### 2.1 Hugging Face ZeroGPU — the only production candidate

**Can it run ACE-Step 1.5? Yes — every compatibility axis checks out, PRIMARY-READ:**

| Requirement | ACE-Step 1.5 | ZeroGPU | Fit |
| --- | --- | --- | --- |
| Python | `requires-python = ">=3.11,<3.13"` | offers 3.12.12 and 3.10.13 | **3.12.12 only** — must be pinned explicitly |
| Gradio | pins `gradio==6.2.0` | Gradio 4+ | ✅ |
| PyTorch | `torch==2.10.0+cu128` on linux-x86_64 | 2.8.0 – 2.13.0 supported | ✅ |
| VRAM | <4 GB (2B); your local 271 s run peaked at tier6a / 17.76 GB | 48 GB on `large` | ✅ ample |
| Licence | **MIT** | — | ✅ free to deploy |
| Model API | `acestep.inference.generate_music`, `GenerationParams`, `GenerationConfig` | — | ✅ callable from a Space `app.py` |

One genuine build obstacle, PRIMARY-READ: `requirements.txt` carries a bare
`flash-attn` for linux-x86_64, and Hugging Face's own ZeroGPU guidance states
the build phase has no `nvcc` (base image `python:3.13`), so sdist-only CUDA
packages — `flash-attn` is the example they name — cannot be installed from
`requirements.txt`. Two known fixes: pin a pre-built wheel matching
cp312 × cu12 × torch 2.10, or drop `flash-attn`/`nano-vllm` and run the LM on
the `pt` backend, which ACE-Step's own README recommends for the 0.6B LM. Work,
not a blocker — but note the second option makes the LM slower, which matters
in §3.

**Quota arithmetic, PRIMARY-READ and not obvious.** `spaces/zero/configs.json`
gives the RTX Pro 6000 Blackwell a `duration_factor` of **1.5**, and
`get_duration_seconds()` applies it whenever size is not `xlarge`. So on the
default `large`, **what you declare is not what you are charged**:

| | declared | sent to scheduler | anon 120 s/day | free acct 300 s/day |
| --- | --- | --- | --- | --- |
| `large` | 60 s | 90 s | 1 song | **3 songs** |
| `large` | 80 s | 120 s | 1 song | 2 songs |
| `large` | 120 s | **180 s** | 0 — likely rejected | 1 song |
| `xlarge` | 120 s | 240 s (×2 server-side) | 0 | 1 song |

Daily quotas are PRIMARY-READ from `hub-docs/docs/hub/spaces-zerogpu.md`:
unauthenticated 2 min, free account 5 min, PRO 40 min, resetting 24 h after
first use. The per-call cap for free-tier visitors is **CORROBORATED at 120 s**
— the ACE-Step team's own Space carries a commit titled "fix: lower ZeroGPU
duration to 120s for free-tier users", and Hub forum threads show
`illegal duration` at 300 s — but it is enforced server-side and appears in no
document I could open, so treat 120 s as the working assumption, not a fact.

**Note the interaction, which is UNVERIFIED and matters:** if the cap is 120 and
the client multiplies by 1.5 before sending, then declaring 120 on `large`
sends 180 and is *itself* rejected as illegal. The safe declared ceiling on
`large` is ~80 s. Measure before relying on it.

**Which visitor tier will our users get?** Almost certainly the
**unauthenticated** one. `spaces/zero/client.py` identifies the visitor from an
`X-IP-Token` header and falls back to IP-based quota when it is absent. That
string does not appear anywhere in `@gradio/client` 2.6.0 (checked), so a
browser calling the Space cross-origin from our own domain does not send one.
**Plan for 2 minutes per day per visitor.**

**Can GitHub Pages call it?** At the Gradio layer, **yes — PRIMARY-READ**.
`CustomCORSMiddleware.is_valid_origin()` is:

```python
return (host_name not in self.localhost_aliases
        or origin_name in self.localhost_aliases)
```

A Space's host is `*.hf.space`, never a localhost alias, so the condition holds
for every origin and Gradio echoes `Access-Control-Allow-Origin: <origin>`.
Whether Hugging Face's edge proxy in front of `*.hf.space` adds a stricter
policy is **UNVERIFIED** — the host is blocked here.

**Terms.** No conflict. `spaces-zerogpu.md`: "ZeroGPU Spaces are available to
use for free to all users", and free personal accounts "in good standing
(verified email, account older than 30 days) can host up to 2 ZeroGPU Spaces
for free". Public visitors invoking a public Space is the product, not a
loophole. Suspension risk: low.

**Verdict: DEVELOPMENT *and* PRODUCTION.** It is the only candidate that can
satisfy every hard acceptance criterion. It is throughput-limited to roughly
**one full song per anonymous visitor per day**, which is a product constraint,
not a criterion failure — no stated criterion demands unlimited generations.

### 2.2 Google Colab Free — DEVELOPMENT ONLY, by the terms

The Colab FAQ's list of activities "disallowed from all managed Colab runtimes"
includes, verbatim: **"file hosting, media serving, or other web service
offerings not related to interactive compute with Colab"** (CORROBORATED —
`research.google.com/colaboratory/faq.html` is egress-blocked here, so this is
the FAQ quoted through the search index, with multiple results agreeing).

GitHub Pages → Colab → ACE-Step → serve a WAV to a stranger is **exactly**
media serving as a web service offering, unrelated to someone interactively
programming in a notebook. It does not matter whether the tunnel is ngrok,
cloudflared, or anything else — the mechanism is not the violation, the use is.
Colab additionally gives no guaranteed GPU, ~90-minute idle disconnects,
~12-hour sessions, and undisclosed dynamic limits, none of which a public
service can be built on.

**Mark: NOT SUITABLE FOR PUBLIC PRODUCTION.** Genuinely good for development —
running ACE-Step on a T4 to compare models or profile a config costs nothing
and breaks no rule.

### 2.3 Kaggle — DEVELOPMENT ONLY

~30 GPU-hours/week and ~12-hour sessions (CORROBORATED; `kaggle.com` is blocked
here, and the 12-hour figure comes from Kaggle's own product-update posts).
Kaggle notebooks accept no inbound connections; a public endpoint would require
a tunnel, and Kaggle is a notebook and competition platform, not a hosting
provider. I will not propose tunnelling out of a platform whose terms I could
not read, to do a thing that platform plainly is not for.

**Mark: NOT SUITABLE FOR PUBLIC PRODUCTION.**

### 2.4 Lightning AI free tier — DEVELOPMENT ONLY

Free plan: 15 Lightning credits/month (≈22 T4-hours), 1 Studio, **free for the
first 4 hours, then billed — restart to continue free** (CORROBORATED;
`lightning.ai` is blocked here). A public API that has to be manually restarted
every four hours, and burns a monthly credit balance while awake, is not a $0
production backend. Fine for development.

### 2.5 Modal Starter — EXCLUDED by your own rule

Technically this is the *best* fit in the entire list: serverless GPU, native
public HTTPS endpoints, configurable CORS, scale-to-zero, no session limits, no
tunnels. It is excluded anyway, on your rule and not on my judgement: the $30
monthly allowance arrives as **$1 on signup and the remaining $29 only after
adding a valid payment method**, plus a one-time $0.50 card-verification charge
(CORROBORATED; `modal.com` is blocked here). Your brief says a service
requiring a credit card is not a permanent $0 solution. That is Modal.

Worth recording as the first thing to reach for if that constraint is ever
relaxed.

### 2.6 Free serverless inference APIs — EXCLUDED, cannot run ACE-Step

Groq, Cerebras, Cloudflare Workers AI (10,000 neurons/day, no card), GMI Cloud
and similar are permanently free and genuinely useful — for **their own model
catalogues**. None accepts an arbitrary uploaded model, none carries a music
generation model, and none carries ACE-Step. They cannot run this workload at
any price tier.

### 2.7 Official ACE-Step hosted inference — EXCLUDED, no free API

There is no official free ACE-Step inference API. Third-party hosts
(WaveSpeedAI, Pixazo and others) bill per second of audio. ACE-Step does run an
official ZeroGPU Space, free to use interactively — but that is their Space,
their hosting, their API surface, and their right to change or pause it.

### 2.8 Community ACE-Step Spaces — EXCLUDED as a production dependency

They exist and they are free to use. Building our product on one means: an API
signature we cannot read from here and did not agree with anyone, an owner who
can rename a function or pause the Space without telling us, and our traffic
riding on a stranger's account. That is not an architecture; it is a favour
being taken without asking.

### 2.9 Also examined and dismissed

Oracle Cloud Always Free (genuinely permanent, but **no GPU** and a card is
required for identity verification — ACE-Step on Ampere CPU would take hours per
song); Google Cloud and AWS free tiers (no GPU, card required); GitHub Actions
(no GPU, and its terms restrict use to the repository's own software project);
GitHub Codespaces (no GPU).

---

## 3. The full-song test — NOT EXECUTED

The brief asks for a real run against the Bos Toxic fixture:
`acestep-v15-turbo`, `acestep-5Hz-lm-0.6B`, `id`, male vocal,
`instrumental=false`, 271 s.

**It was not run, and it could not be run from here.** No GPU in this container;
`huggingface.co` and `*.hf.space` blocked at the proxy; no Space exists yet to
run it on. Every field the brief asks to record — GPU type, VRAM, model load
time, generation time, total request time, output duration, completion, runtime
termination, quota consumed, WAV validity — is therefore **unmeasured**, and I
am not going to fill them with estimates dressed as results.

### What the evidence suggests, clearly labelled as an estimate

`docs/en/BENCHMARK.md` carries an illustrative output table — **illustrative, on
an unnamed GPU, not a measurement**:

```
Duration  Batch  Think  Steps   Wall(s)   LM(s)   DiT(s)   VAE(s)
30        1      True   8       5.67      2.91    1.89     0.52
```

DiT and VAE cost scale roughly with audio length; LM planning is token-bound and
roughly flat. Extrapolating to 271 s: DiT ≈ 17 s, VAE ≈ 5 s, LM ≈ 3 s →
**≈ 25 seconds of GPU**, comfortably inside a declared 60 s.

Three reasons not to trust that number yet: the source table is illustrative and
names no GPU; ZeroGPU `large` is **half** a card; and if we drop `nano-vllm` to
dodge the `flash-attn` build problem, the 0.6B LM runs on the `pt` backend
instead of vLLM, and with constrained decoding and CFG the LM stage can dominate
rather than stay flat. The corroborating fact that cuts the other way is that
ACE-Step's own maintainers set `duration=120` on their ZeroGPU Space
specifically so free-tier users could run it — they evidently expect their full
generation to fit.

### The test that settles it

One run, on a Space, before any provider code is written:

1. Deploy a Space with the Bos Toxic fixture hard-wired as the default input.
2. Decorate with `@spaces.GPU(duration=120)` first — purely to find out whether
   the 1.5 factor makes that an `illegal duration` on `large`.
3. Log, inside the handler: `torch.cuda.get_device_name()`, total VRAM, model
   load time (startup, outside the decorator), LM / DiT / VAE times, wall time
   inside the decorator, and the returned WAV's real duration and peak
   amplitude.
4. Read the quota actually consumed from the error message on a deliberate
   second call.
5. Re-declare `duration` to the measured worst case + margin, and only then
   write the provider.

If step 3 reports a wall time under ~80 s, every hard criterion below is met and
this project has a $0 production path. If it reports more, ZeroGPU drops to
DEVELOPMENT/DEMO ONLY and there is, on today's evidence, nothing else.

---

## 4. Top 3, ranked

### #1 — Hugging Face ZeroGPU Space (custom, owned by you)

1. **Why it works.** The only free platform that hosts *your* model, exposes a
   *public* HTTP API, permits *anonymous* visitors to invoke it, and says so in
   its own documentation. ACE-Step 1.5 is compatible on every axis
   (PRIMARY-READ). The model generates 10–600 s in one request, so a 3–5 minute
   song needs no chunking and no continuity tricks.
2. **Cost.** $0. Requires a Hugging Face account with a verified email, older
   than 30 days. Max 2 ZeroGPU Spaces.
3. **Limitations.** Free per-call GPU cap ~120 s (corroborated). `large` charges
   declared × 1.5. Visitors are billed as unauthenticated: ~2 min/day → about
   one full song each. Sleeps after ~2 days idle; cold start is minutes because
   of ~11 GB of weights. Gradio SDK only. `flash-attn` must be replaced or
   pre-built.
4. **Full-song feasibility.** Model side: **verified yes** (10–600 s, one
   request). Compute side: **unmeasured** — §3.
5. **GitHub Pages integration.** `POST /gradio_api/call/<our api_name>` →
   `{event_id}`, then `GET .../<event_id>` SSE (PRIMARY-READ from Gradio
   source). CORS permits any origin at the Gradio layer (PRIMARY-READ); the HF
   edge proxy is unverified and is the first thing to test.
6. **Risk.** Low on terms and suspension. Real risk is throughput: a visitor
   gets roughly one song per day and must be told so honestly.
7. **Acceptable?** **Yes — pending the one measurement in §3.**

### #2 — Google Colab Free — development only

1. Free T4-class GPU, zero setup, good for profiling and A/B-ing models.
2. $0.
3. No guaranteed GPU; ~90-minute idle; ~12-hour cap; undisclosed dynamic limits.
4. Full-song generation in a notebook: yes, fine.
5. **GitHub Pages integration: prohibited.** "Media serving or other web service
   offerings not related to interactive compute with Colab" is disallowed.
6. Using it as a backend risks the account.
7. **Acceptable as production? No. Acceptable as dev compute? Yes.**

### #3 — Kaggle — development only

1. ~30 GPU-hours/week, P100 or 2×T4, more generous than Colab for batch work.
2. $0.
3. 12-hour sessions, no inbound connections, notebook-shaped.
4. Full-song generation in a notebook: yes.
5. **No public endpoint without tunnelling out of a platform that is not a host.**
6. Same account risk as Colab.
7. **Acceptable as production? No. Acceptable as dev compute? Yes.**

---

## 5. RECOMMENDED ARCHITECTURE

```
GitHub Pages  (jamalbalya.github.io/aimusicgenerated)     ← public frontend, unchanged
      │   style + full lyrics, one request
      ▼
Hugging Face ZeroGPU Space   <your-account>/<space>.hf.space   ← free, public, yours
      │   POST /gradio_api/call/<api_name>   → { event_id }
      │   GET  /gradio_api/call/<api_name>/<event_id>   (SSE)
      ▼
@spaces.GPU(duration = measured worst case)      ← declared from §3, never guessed
      ▼
ACE-Step 1.5 · acestep-v15-turbo · acestep-5Hz-lm-0.6B
      │   audio_duration = 271   (model range 10–600, one request)
      ▼
ONE complete WAV — vocal + instrumental, Indonesian, 4½ minutes

Mac M2  ──►  development and testing only, never in this path.
Colab / Kaggle  ──►  development compute only, never in this path.
```

Not to be built yet.

---

## 6. Hard acceptance criteria

| | Criterion | HF ZeroGPU |
| --- | --- | --- |
| ✅ | $0 | Free Space, free visitors, no card |
| ✅ | No Mac production server | Mac is dev-only |
| ✅ | ACE-Step 1.5 | MIT, deployable, compatible |
| ❓ | **Full song in ONE generation request** | Model: verified. Compute within the free cap: **UNMEASURED** |
| ✅ | 3–5+ minutes | `audio_duration` range 10–600 s |
| ✅ | Vocal | `instrumental=false`, LM thinking on |
| ✅ | Instrumental | same generation, same request |
| ✅ | Indonesian lyrics | 50+ languages; `id` already proven locally |
| ✅ | Style + lyrics preserved | `verifyLyricsPreserved()` already exists and carries over |
| ✅ | Remote access possible | public Gradio HTTP API |
| ❓ | GitHub Pages compatible | Gradio CORS: verified. HF edge proxy: **UNVERIFIED** |
| ✅ | Does not violate provider terms | public ZeroGPU Spaces are the intended use |
| ✅ | No paid credits required | none |
| ✅ | No fake/unverified API | endpoints read from Gradio source, `api_name` ours to define |
| ✅ | No silent procedural fallback | existing `no-fallback` test harness extends to the remote provider |

Two boxes are open, and both are open for the same reason: **they need one real
run and one real cross-origin request, neither of which this environment can
perform.**

Therefore, stating it the way the brief requires:

> **No currently verified $0 production solution satisfies all requirements.**

Not because a requirement was shown to be unreachable — but because "verified"
means executed, and nothing was executed. Hugging Face ZeroGPU is the only
candidate that fails none of the criteria on the evidence available, and it is
two short tests away from being either confirmed or ruled out. Everything else
in the field fails a criterion outright: Colab and Kaggle on provider terms,
Modal on the credit-card rule, the free serverless APIs on being unable to run
ACE-Step at all, and the hosted and community options on being someone else's.

**No requirement was lowered to reach this conclusion.**
