# Neural music generation

Resonant Studio can generate songs two ways. This document is about the second
one, and about the boundary that keeps them from being confused with each other.

| | Offline Procedural | Neural |
|---|---|---|
| Engine | the composer and singer in this repository | ACE-Step 1.5 |
| Runs on | the browser tab | a free Hugging Face ZeroGPU Space, or your own backend |
| Needs a server | no | yes |
| Cost to run | none | none on ZeroGPU, within each visitor's daily GPU allowance |
| Works offline | yes | no |
| Singer | formant synthesis — audibly synthetic | a neural model |

Both are real engines. Neither pretends to be the other, and the interface
always names which one made a given song.

## The current neural backend: ACE-Step 1.5 on ZeroGPU

The public site's neural engine is **ACE-Step 1.5 Turbo (`acestep-v15-turbo`)
with the 0.6B language model (`acestep-5Hz-lm-0.6B`)**, running on a free
Hugging Face ZeroGPU Space built from `poc/zerogpu-space/`. The Mac setup further
down stays what it was: development and testing, never the public server.

**Validated.** On 2026-09-11 the project owner generated the Bos Toxic fixture on
the live Space — 68 lyric lines, Indonesian, male vocal, sung — and got **one
complete 271-second, 48 kHz, stereo, 16-bit WAV from one request**, in about 45
seconds of generation, with no chunking and no out-of-memory failure. The
Space's API contract, its Gradio version, and its CORS headers for
`https://jamalbalya.github.io` were checked against the live Space the same day;
see `zerogpu-full-song-test.md` for exactly what was and was not verified.

**One request, one complete WAV.** The studio sends the whole style and the
whole lyric sheet together, once, and gets the whole song back. There is no
chunked generation anywhere in this path, and a result shorter than the length
asked for is refused rather than shown.

**Two durations, which are not the same thing:**

| | What it is | Where it is set |
|---|---|---|
| Song length | how long the song is — 271 s in the validated run | the Length control; Auto becomes `ACE_STEP_SPACE_AUTO_DURATION` (default 271) |
| ZeroGPU duration | how many seconds of GPU one request may occupy — 80 | `@spaces.GPU(duration=80)` in the Space's `app.py` |

The 271-second song used about 45 of its 80 GPU seconds. Measured on that run,
from the Space's own report: the 0.6B language model took 36.3 s, the DiT
diffusion 1.9 s (8 steps at 0.23 s), and VAE decoding 3.2 s; loading the models
beforehand took about 45 s but happens at startup, outside the GPU budget.

**The validated baseline is 271 seconds (4:31). Nothing longer has been
verified.** A longer song needs more GPU time; the studio neither caps the
length at 271 nor presents anything up to its 7-minute slider as verified — in
Neural mode on ZeroGPU, a length over 4:31 is labelled as unverified next to the
Length control. `ACE_STEP_SPACE_MAX_DURATION` sets a hard ceiling if one is
wanted. A song that does outrun the GPU budget fails with ZeroGPU's own "GPU task
aborted", reported as an unsupported length.

Settings are in `docs/architecture/environment.md`.

### How the studio talks to the Space

```
StudioPage / useNeuralEngine
  └── createNeuralProvider()        providers/registry.ts   ← the only place one is built
        └── ZeroGpuProvider         providers/zeroGpuProvider.ts
              │  maps the request onto the Space's six inputs, resolves Auto,
              │  checks the answer against what was asked
              └── GradioClient      providers/gradioClient.ts
                    │  Gradio's queue protocol, and nothing else
                    └── POST {space}/gradio_api/queue/join   → event_id
                        GET  {space}/gradio_api/queue/data   → SSE: estimation, process_starts,
                                                               log, heartbeat, process_completed
                        GET  {space}/gradio_api/file=…       → the WAV
```

The client uses Gradio's full queue protocol rather than the shorter
`/call/{api_name}` route, because in Gradio 6.2.0 that route drops the error
text on failure (`event: error`, `data: null`) — and "your free GPU quota is
used up, try again in 1:23:45" is exactly the message a person needs to see.

The Space's `app.py` stays the one place a request becomes ACE-Step settings:
it adds the vocal gender to the caption, swaps in the instrumental marker, turns
the language model on, and refuses to run on a substituted model. The browser
sends the six inputs the Space declares and changes none of them:

| Input | Sent as |
|---|---|
| `style` | the style, word for word — with one exception, below |
| `lyrics` | the lyric sheet, every line and section tag, line endings normalised to LF |
| `language` | the chosen or detected language |
| `vocal_gender` | `male` or `female` when chosen; **Auto is sent as `mixed`**, which adds nothing, so the style's own words decide |

The exception. The Space adds "<gender> lead vocal" to the caption unless the
caption already contains the gender — but it checks with Python's substring
`in`, and "male" is inside "female" and "malevolent". Left alone, choosing Male
on "soft female vocal" or "malevolent trap" would add nothing. The Space is not
changed; instead, when the chosen gender appears in the style only inside
another word, the studio appends the Space's own hint, in the Space's own
format, and the Space's check then finds it. Every other style is sent exactly
as written — the validated Bos Toxic request included — and a test replays the
Space's rule over a matrix of styles to prove the chosen voice always ends up in
the caption as a whole word.
| `instrumental` | the studio's choice |
| `duration` | a whole number of seconds; Auto becomes the configured Auto length, never `-1` |

The answer is then checked against the request: the models the Space reports it
ran must be turbo and 0.6B, the lyric line count it received must equal the one
sent, the language, instrumental choice and length must match, and the WAV
itself must be valid, audible and as long as asked.

### When it fails

Every failure is named and none of them falls back to the procedural engine:

| What happened | Reported as |
|---|---|
| Space asleep, unreachable, wrong protocol, endpoint gone | engine unavailable |
| Result stream silent for 60 s (Gradio heartbeats every 15 s) | engine unavailable — connection lost |
| ZeroGPU quota spent | quota exceeded, with ZeroGPU's own "try again in" wording; **never retried**, and a multi-take run stops there |
| GPU duration refused, or the song outran it | unsupported length |
| The Space's code raised | generation failed, with its message |
| Queue failed outside the handler | unexpected error |
| HTTP error on submit or download | HTTP error, with the status and the Space's reason |
| Outputs malformed, models swapped, lyrics short, a file that is not a readable WAV, a clip instead of a song | bad result |
| No audio returned | missing audio |
| Over `ACE_STEP_SPACE_TIMEOUT_SECONDS`, or ZeroGPU's own GPU-queue timeout | timeout |
| The user pressed Cancel | cancelled |

Nothing in the provider retries a submission, so no failure can quietly cost a
second slice of anyone's GPU allowance.

The length that counts is the one measured from the downloaded WAV's own
header. The Space's metadata is checked against the request, but its word is
never taken for the audio itself: bytes that do not parse as a WAV are refused
even when the metadata says 271 seconds.

Nor does the engine choice move behind anyone's back. Until someone picks an
engine, the Studio moves onto Neural once the backend has answered — and stays
there. A hosted Space missing one health check would otherwise flip the control
back to Offline Procedural, and the next Generate or ⌘/Ctrl + Enter would
quietly produce a procedural song. With the control held, it goes to the neural
engine and fails out loud.

## Why ACE-Step

The offline engine has a ceiling that is not a tuning problem. Its vocal is
source–filter formant synthesis: it sings in tune, in the right language, with
the right words at the right moments, and it is unmistakably a synthesiser.
`docs/quality/bos-toxic-evaluation.md` measures exactly where that sits and what
it would take to move.

ACE-Step 1.5 was chosen over the alternatives because it is the only one that
meets all four constraints this project has:

- **It generates a complete song from style and lyrics** — vocal, melody,
  harmony, rhythm, arrangement and mix in one pass — rather than being a singing
  voice synthesiser that still needs a backing track written for it.
- **The weights and the code are available**, so a user can run it themselves.
  Nothing about this path requires an account, a subscription or a per-song fee.
- **It has a supported HTTP API and a supported Apple Silicon backend**, so
  integrating it means talking to a service rather than reimplementing a model.
- **It is multilingual**, including Indonesian, which the offline engine already
  supports and which this project's test case is written in.

The integration targets the official project at
<https://github.com/ACE-Step/ACE-Step-1.5>. This repository contains no model
architecture, no weights, and no vendored copy of it.

## Architecture

```
Browser
  └── Resonant Studio (React)
        └── MusicGenerationProvider          src/engine/providers/types.ts
              ├── createNeuralProvider()     src/engine/providers/registry.ts  (ACE_STEP_BACKEND)
              │     ├── ZeroGpuProvider      src/engine/providers/zeroGpuProvider.ts   ← zerogpu
              │     │     └── GradioClient → ACE-Step 1.5 Space on ZeroGPU → complete WAV
              │     └── AceStepProvider      src/engine/providers/aceStepProvider.ts   ← local
              │           └── ACE-Step 1.5 HTTP API  (default 127.0.0.1:8001)
              │                 └── neural generation → complete WAV
              └── ProceduralMusicProvider    src/engine/providers/proceduralProvider.ts
                    └── existing composer, arranger and procedural singer
```

`MusicGenerationProvider` is deliberately small and knows nothing about either
engine: no HTTP, no workers, no `Float32Array`, no mention of ACE-Step. A
request carries the style, the lyrics, a language, a vocal gender, a duration, a
seed, and which models to use. A result carries an id, the engine that made it,
a playable URL, a duration and metadata.

### Files

| File | What it is |
|---|---|
| `providers/types.ts` | the interface, the request, the result, the states |
| `providers/aceStepRequest.ts` | the deterministic style/lyric adapter |
| `providers/aceStepClient.ts` | typed client for ACE-Step's HTTP contract |
| `providers/aceStepProvider.ts` | submit, poll, download, report — the local backend |
| `providers/zeroGpuProvider.ts` | the ZeroGPU backend: request mapping, Auto length, error mapping, result checks |
| `providers/gradioClient.ts` | Gradio's queue protocol and SSE stream; knows nothing about ACE-Step |
| `providers/proceduralProvider.ts` | the existing engine behind the same interface |
| `providers/registry.ts` | the one provider factory, mode selection, and the refusal to substitute |
| `providers/config.ts` | which backend, and where it lives, validated strictly |
| `ui/useNeuralEngine.ts` | the connection probe behind the status dot |

## The generation path, end to end

Every transition, with the file and function that makes it.

| Step | Where |
|---|---|
| The Generate button | `ui/pages/StudioPage.tsx` → `generateSong()` |
| Branch on the chosen engine | `generateSong()` — neural calls `generateNeural()`, offline calls `generate()` |
| Build the request | `generateNeural()` assembles a `MusicGenerationRequest` |
| Pick the provider | `new AceStepProvider()` (`providers/aceStepProvider.ts`) |
| Is the backend there | `AceStepProvider.generate()` → `client.health()` |
| Are the models the right ones | `AceStepProvider.verifyModels()` |
| Style and lyrics → ACE-Step body | `providers/aceStepRequest.ts` → `buildAceStepTask()` |
| Create the task | `AceStepClient.createTask()` → `POST /release_task` |
| Poll | `AceStepProvider.poll()` → `AceStepClient.queryResult()` → `POST /query_result` |
| Unpack the doubly-encoded result | `parseResultItems()` |
| Download the audio | `AceStepClient.fetchAudio()` → `GET /v1/audio?path=…` |
| Is it really audio | `providers/audioCheck.ts` → `describeAudio()` |
| Blob → object URL | `AceStepProvider.generate()` → `toObjectUrl()` |
| Object URL → samples | `generateNeural()` → `fetch()` → `decodeWav()` |
| Into the player | `openNeuralTake()` → `useStudio.setCurrent()` |
| Metadata on screen | the neural Result panel in `StudioPage.tsx` |

The offline engine takes the same shape through `providers/proceduralProvider.ts`,
which wraps the existing worker (`workers/client.ts` → `workers/handler.ts`).

## Things that will not silently pass

| Failure | What happens |
|---|---|
| Backend not running | `EngineUnavailableError`, with the offer to switch. No song. |
| HTTPS page, `http://` backend | Reported as mixed content before any request is made |
| Backend loaded a different LM | Refused, naming both models |
| Backend loaded a different DiT | Refused, naming both models |
| `thinking` requested, no LM loaded | Refused — that song would come back instrumental |
| Download empty, truncated, or an HTML error page | Refused |
| A valid WAV containing silence | Refused |
| No duration reported and none measurable | Refused |
| A poll fails once | Retried; the job keeps running |
| Polls fail five times running | Given up, saying the job may still be running on the backend |
| One take of several fails | The others are kept, and the failed one is named |
| Cancelled | Polling stops; the message says the backend may still be working |

## The rule this design exists to enforce

**A neural request is never quietly served by the procedural engine.**

Someone who asks for a neural song and receives a procedural one has no way to
know that happened. They would listen to a synthesised vocal and conclude that
is what the neural model sounds like. So when the backend is not reachable, the
request fails and says:

> Neural music engine is unavailable. You can start the ACE-Step backend or
> switch to Offline Procedural Mode.

alongside a button that does exactly that. Switching engines is always
available — as a choice, made once, by the person making it.

The backend probe *is* allowed to decide which mode the control starts in. That
is not a substitution: it is the initial position of a visible switch, before
any request has been made.

## The ACE-Step HTTP contract

Taken from the repository at commit `ca1e85f`. Every response is wrapped:

```json
{ "data": ..., "code": 200, "error": null, "timestamp": 0 }
```

| Endpoint | Method | Used for |
|---|---|---|
| `/health` | GET | is it running, and what is loaded |
| `/release_task` | POST | queue a generation, returns `task_id` |
| `/query_result` | POST | poll `{"task_id_list": ["…"]}` |
| `/v1/audio?path=…` | GET | download the finished file |
| `/v1/models` | GET | which DiT and LM checkpoints are available |

Two details are easy to get wrong and are handled explicitly:

- `/query_result` returns `result` as a **JSON-encoded string**, not an object.
  It has to be parsed a second time.
- Status is an integer: `0` processing (queued *or* running), `1` success,
  `2` failed.

The `/query_result` fixtures used by the tests were generated by running
ACE-Step's own response builders
(`acestep/api/http/query_result_service.py`), so the parser is held against what
the server emits rather than against a guess.

## What is sent, and what is not changed

The style prompt goes through **whole**. Reducing
`"Indonesian dangdut koplo, sarcastic workplace anthem, powerful kendang, groovy
bass, funky guitar, dramatic male vocal, humorous verses, explosive sing-along
chorus"` to `genre=dangdut, mood=sarcastic` throws away most of what the model
reads.

The lyrics go through **byte for byte**, section tags and their qualifiers
included, so `[Chorus, Full Koplo]` and `[Break, Kendang Call And Response]`
still say what they say. Nothing is rewritten, translated, trimmed, or
re-spelled phonetically. `verifyLyricsPreserved()` exists so a test can prove
that rather than trust it, and it is asserted against all 68 lines and 12
section tags of the Bos Toxic sheet.

Two request flags matter and are set deliberately:

- `thinking: true` — puts the 5 Hz language model in the chain, which is what
  produces singing rather than a backing track.
- `use_format: false` — that flag asks the LM to "enhance" the caption and the
  lyrics. The lyrics are the user's.

Vocal gender has no parameter in ACE-Step; a voice is described in the caption.
The adapter appends `", male lead vocal"` **only** when the style does not
already mention a gender, so it never overwrites what the user wrote.

## Progress, and why there is no percentage

The states are `idle`, `initializing`, `queued`, `generating`, `completed`,
`failed`, `cancelled`. `queued` and `generating` are separate because waiting
for a machine and using one are different things to be told.

The interface shows a progress **bar** only when ACE-Step publishes a progress
number for that task. Otherwise it shows the stage name the server reported, in
words. A bar that advances on a timer tells the user something false about how
long they are waiting.

## Cancellation

**ACE-Step 1.5 exposes no cancellation endpoint.** Cancelling therefore:

- stops the polling,
- settles the request locally as cancelled,
- and says so plainly: *"Stopped waiting. The backend may still be finishing
  this song."*

`AceStepProvider` does not implement the optional `cancel(jobId)` method, rather
than implementing it as a no-op that would imply the work had stopped.

## Several takes

Asking for N takes in neural mode runs N **independent generations**, each with
its own seed. One audio file is never varied into several: a variation of one
render is not a second take of anything.

## Mac M2 setup

The whole path, in the order to run it. Everything below assumes an Apple
Silicon Mac; CUDA is not required anywhere and is never used.

### 1. Install

```bash
./scripts/setup-ace-step-macos.sh
```

Verifies macOS, arm64, the chip and the memory; installs `uv` if it is missing
(the official `curl -LsSf https://astral.sh/uv/install.sh | sh`); clones or
updates ACE-Step; runs `uv sync`; downloads the models; checks the files are
really there; prints the disk usage; and checks MLX imports.

Takes a while on first run — `uv sync` builds an environment and the weights are
about 10 GB.

### 2. Download models

Step 1 does this for you. By hand, from inside the ACE-Step checkout:

```bash
uv run acestep-download --dir ~/Models/ACE-Step-1.5 --model acestep-5Hz-lm-0.6B
```

Asking for a sub-model downloads the main bundle first when it is missing, so
that single command covers both.

The main bundle carries `acestep-v15-turbo`, `vae`, `Qwen3-Embedding-0.6B` and
`acestep-5Hz-lm-1.7B`. The **0.6B LM is separate** and must be named.

### 3. Start ACE-Step

```bash
./scripts/start-ace-step-macos.sh
```

Checks Apple Silicon, the installation and every model file before starting
anything, then hands over to ACE-Step's own `start_api_server_macos.sh` (which
also repairs MLX against the running macOS version). Runs in the foreground —
leave it open, Ctrl-C stops it.

It exports `ACESTEP_LM_MODEL_PATH=acestep-5Hz-lm-0.6B`,
`ACESTEP_LM_BACKEND=mlx` and `ACESTEP_CHECKPOINTS_DIR`, which is how the smaller
LM and the shared weights directory are selected without editing anything
upstream.

The first *request* is what loads the models, so expect several minutes on it.

### 4. Verify the backend

In a second terminal:

```bash
./scripts/diagnose-ace-step-macos.sh     # full report, READY or NOT READY
node scripts/ace-step-status.mjs         # the same answer in one screen
```

Both exit non-zero when not ready. Neither reports READY from configuration:
the only evidence accepted is a reply from `/health`.

### 5. Generate Bos Toxic

```bash
./scripts/generate-bos-toxic-macos.sh
```

The first real generation, fixed at:

| | |
|---|---|
| DiT | `acestep-v15-turbo` |
| LM | `acestep-5Hz-lm-0.6B` |
| Language | `id` |
| Vocal | male |
| Instrumental | false |
| `thinking` | true |

No parameter sweep — one successful real generation first.

### 6. Find the audio

```
evaluation/bos-toxic/bos-toxic-<model>-<timestamp>.wav
evaluation/bos-toxic/bos-toxic-<model>-<timestamp>.json
```

`evaluation/` is gitignored. Generated audio is never committed.

The JSON beside the WAV records the task id, the ACE-Step version and commit,
the models the server said it loaded, the device and backend, the wall-clock
generation time, the reported output duration, BPM and key.

### 7. Connect the studio

```bash
cp .env.example .env      # VITE_ACE_STEP_API_URL=http://127.0.0.1:8001
npm run dev
```

The Studio header shows **Neural Engine: ● Connected** once `/health` answers.
Pick **Neural**, write a style and lyrics, and generate.

### 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `uv: command not found` after setup | The installer added it to `~/.local/bin`; open a new terminal. |
| Setup fails downloading weights | Re-run it; the download resumes. `acestep-download` has no source flag and auto-detects HuggingFace vs ModelScope. |
| Diagnose says models missing | A partial download leaves directories with no weights file, which reads as missing. Re-run the setup script. |
| `Something is already listening on port 8001` | An older server is still up. Stop it, or set `ACE_STEP_PORT`. |
| MLX will not import | Run `uv pip install -U mlx mlx-lm` inside the ACE-Step checkout. The macOS launcher also attempts this. |
| First generation seems to hang | Models load on the first request, not at startup. Watch the server terminal. |
| Studio says Not Connected but curl works | The page must be `http://localhost` — an HTTPS page cannot call an `http://` backend, and the studio says so rather than probing. |
| Generation fails with memory errors | 24 GB is comfortable for the 0.6B LM. Set `ACE_STEP_LM_MODEL=acestep-5Hz-lm-0.6B` and avoid the 1.7B and 4B until the small one works. |
| Want to start over | Delete `~/Models/ACE-Step-1.5` and re-run setup. The clone can stay. |

### Where things live

| | Default | Override |
|---|---|---|
| ACE-Step source | `~/Applications/ACE-Step-1.5` | `ACE_STEP_HOME` |
| Model weights | `~/Models/ACE-Step-1.5` | `ACE_STEP_MODELS` |
| Generated audio | `evaluation/bos-toxic/` | — |

All of them are read from `scripts/ace-step-env.sh`, which reads `.env` first.
No personal path is hardcoded anywhere. The full variable reference is
`docs/architecture/environment.md`.

## Local setup

### 1. Get ACE-Step

```bash
git clone https://github.com/ACE-Step/ACE-Step-1.5
cd ACE-Step-1.5
curl -LsSf https://astral.sh/uv/install.sh | sh   # if uv is not installed
uv sync
```

### 2. Download the weights

Model weights are **not** stored in this repository and never will be. They come
from the ACE-Step project's own distribution, using its own downloader:

```bash
uv run acestep-download --dir ~/Models/ACE-Step-1.5                              # main bundle
uv run acestep-download --dir ~/Models/ACE-Step-1.5 --model acestep-5Hz-lm-0.6B  # + the small LM
uv run acestep-download --list                                                   # what exists
```

The **main bundle** contains `acestep-v15-turbo`, `vae`, `Qwen3-Embedding-0.6B`
and `acestep-5Hz-lm-1.7B`. Note what that means: the 1.7B LM ships with it, and
**`acestep-5Hz-lm-0.6B` is a separate sub-model** that has to be asked for by
name. Models also download automatically on first run if you skip this step.

`ACESTEP_CHECKPOINTS_DIR` decides where they land, which is how the scripts here
keep them out of both repositories.

### 3. Start the backend

```bash
# Linux / Windows with an NVIDIA GPU
./start_api_server.sh

# macOS, Apple Silicon — uses the native MLX backend
./start_api_server_macos.sh
```

Both bind `0.0.0.0:8001` by default. `ACESTEP_API_HOST` and `ACESTEP_API_PORT`
change that.

### Apple Silicon

ACE-Step ships a native MLX backend for Apple Silicon and
`start_api_server_macos.sh` selects it by exporting `ACESTEP_LM_BACKEND=mlx`.
The script checks that `mlx.core` and `mlx_lm` import against the running macOS
version and reinstalls them if not.

CUDA is **not** required and must not be assumed: the Linux requirements pin
CUDA wheels, the macOS ones pin ordinary CPU/MPS builds plus MLX. Install with
the macOS path on an M-series machine.

### 4. Point the studio at it

```bash
cp .env.example .env
# VITE_ACE_STEP_API_URL=http://127.0.0.1:8001
npm run dev
```

The header shows **Neural Engine: ● Connected** once the backend answers
`/health`. Until then it shows **● Not Connected** — never "available".

## Environment variables

The full, authoritative list — including the ZeroGPU settings and the repository
variables the public deploy reads — is `docs/architecture/environment.md`. For
the local backend described in this section:

| Variable | Read by | Default |
|---|---|---|
| `ACE_STEP_BACKEND` | the browser bundle | `local` |
| `ACE_STEP_API_URL` | the smoke test and the browser bundle | `http://127.0.0.1:8001` |
| `ACE_STEP_API_KEY` | the smoke test and the browser bundle | unset |
| `ACE_STEP_MODEL` | the smoke test and the browser bundle | `acestep-v15-turbo` |
| `ACE_STEP_LM_MODEL` | the smoke test and the browser bundle | `acestep-5Hz-lm-0.6B` |

## Verifying it end to end

```bash
./scripts/generate-bos-toxic-macos.sh
```

Checks the backend is up, submits the Bos Toxic style and lyrics in Indonesian
with a male vocal, polls to completion, downloads the WAV into `evaluation/`
(gitignored), and prints the models that ran, the wall-clock generation time and
the length of the result. Exits non-zero if any of that fails.

The mocked half of the same case lives in `tests/unit/neural.test.ts` and runs in
CI, where there is no GPU and no multi-gigabyte download.

## Deployment

**GitHub Pages cannot run ACE-Step.** Pages serves static files; it has no
process, no GPU and no Python. So the site at
`jamalbalya.github.io/aimusicgenerated` does not run the model — it calls the
ZeroGPU Space, which does:

```
Browser
  └── HTTPS → Resonant Studio (GitHub Pages, static)
        └── HTTPS → ACE-Step 1.5 Space on Hugging Face ZeroGPU   (free, sign-in required)
              └── one request → one complete WAV
```

That path answers every point below for the hosted backend. CORS: Gradio
echoes the page's origin, and the live Space returned
`access-control-allow-origin: https://jamalbalya.github.io` for both the GET and
the POST preflight. Mixed content: the Space is HTTPS. Authentication: the
visitor signs in with Hugging Face and the browser sends that OAuth token as a
bearer; the Space verifies it and refuses anonymous callers with 401. Cost:
none — each visitor spends their own daily ZeroGPU allowance, and running out is
reported as exactly that.

The deploy workflow builds with `ACE_STEP_BACKEND=zerogpu` and reads the Space's
address from the `ACE_STEP_SPACE_URL` repository variable.

For a public deployment on a backend of your own instead:

```
Browser
  └── HTTPS → Resonant Studio (static hosting)
        └── HTTPS → your ACE-Step backend
              └── GPU or Apple Silicon
```

Things that then need attention, none of which are solved here:

- **CORS.** ACE-Step's own CORS policy allows only `localhost` and `127.0.0.1`
  origins. A remote frontend needs the backend fronted by a proxy that sets the
  right `Access-Control-Allow-Origin`.
- **Mixed content.** An HTTPS page cannot call an HTTP backend; the backend
  needs TLS.
- **Authentication.** `ACESTEP_API_KEY` gates the API, but a key shipped in a
  browser bundle is a public key. A real deployment puts a server in front.
- **Cost.** A GPU that is always on is the entire reason commercial generators
  charge per song.

## What has been verified, and what has not

Being precise about this matters more than usual here, because the difference
between "the integration is written" and "the model made a song" is the whole
point of the exercise.

**Verified:**

- The provider boundary, the request adapter, the client and the two engines,
  by 20 tests in `tests/unit/neural.test.ts`.
- That the Bos Toxic style survives whole and all 68 lyric lines and 12 section
  tags survive byte for byte into the `/release_task` body.
- That the response parser reads ACE-Step's real payloads — the fixtures were
  generated by running ACE-Step's own `query_result_service.py`.
- That a neural request with no backend fails with the documented message and
  offers the offline engine, in the unit tests and in a browser test.
- That the offline engine still composes, sings and returns its own output
  through the same interface.
- That the smoke script and the in-app adapter build an identical request.

**Not verified, because it cannot be from this repository's CI or from a machine
without the hardware:**

- That ACE-Step generates a song from this request. That needs the backend
  running, the weights downloaded, and a GPU or Apple Silicon machine.
- Anything at all about how the result sounds.

`./scripts/generate-bos-toxic-macos.sh` is the step that closes that gap, and it
is written to fail loudly rather than pass vacuously. Until it has been run and
the audio listened to, no quality claim about the neural path should be made —
including by this repository's own documentation.

The project's quality level therefore stands at **LEVEL 1**, which is the
measured grade of the *procedural* engine. Nothing about the neural path's
quality is known, and "ACE-Step generated audio successfully" would not be
LEVEL 3 in any case: LEVEL 3 means the same perceived quality class as the
TopMediai reference, judged by listening.

## Limitations

- No cancellation on the server side; see above.
- ACE-Step's queue runs one worker: `ACESTEP_QUEUE_WORKERS` is documented as
  single-GPU, so several takes are generated one after another, not at once.
- Stems, MIDI export and the chord chart are features of the **procedural**
  engine, which has a score behind it. A neural result is a finished recording;
  there is no arrangement to export.
- Nothing in this document claims a quality result. The neural path's audio has
  to be generated and listened to before anything is said about how it sounds.
