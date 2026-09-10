# Neural music generation

Resonant Studio can generate songs two ways. This document is about the second
one, and about the boundary that keeps them from being confused with each other.

| | Offline Procedural | Neural |
|---|---|---|
| Engine | the composer and singer in this repository | ACE-Step 1.5 |
| Runs on | the browser tab | a backend with a GPU or Apple Silicon |
| Needs a server | no | yes |
| Cost to run | none | whatever the hardware costs |
| Works offline | yes | no |
| Singer | formant synthesis — audibly synthetic | a neural model |

Both are real engines. Neither pretends to be the other, and the interface
always names which one made a given song.

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
              ├── AceStepProvider            src/engine/providers/aceStepProvider.ts
              │     └── ACE-Step 1.5 HTTP API  (default 127.0.0.1:8001)
              │           └── neural generation → complete WAV
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
| `providers/aceStepProvider.ts` | submit, poll, download, report |
| `providers/proceduralProvider.ts` | the existing engine behind the same interface |
| `providers/registry.ts` | mode selection, and the refusal to substitute |
| `providers/config.ts` | where the backend lives |
| `ui/useNeuralEngine.ts` | the connection probe behind the status dot |

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

## Local setup

### 1. Get ACE-Step

```bash
git clone https://github.com/ACE-Step/ACE-Step-1.5
cd ACE-Step-1.5
./install_uv.sh          # or follow docs/en/INSTALL.md
```

### 2. Download the weights

Model weights are **not** stored in this repository and never will be. They come
from the ACE-Step project's own distribution:

```bash
huggingface-cli download ACE-Step/Ace-Step1.5 --local-dir ./checkpoints
```

ACE-Step also supports ModelScope as a source, and its downloader picks between
them automatically.

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

| Variable | Read by | Default |
|---|---|---|
| `VITE_ACE_STEP_API_URL` | the browser bundle | `http://127.0.0.1:8001` |
| `VITE_ACE_STEP_API_KEY` | the browser bundle | unset |
| `ACE_STEP_API_URL` | the smoke test | `http://127.0.0.1:8001` |
| `ACE_STEP_API_KEY` | the smoke test | unset |
| `ACE_STEP_MODEL` | the smoke test | `acestep-v15-turbo` |
| `ACE_STEP_LM_MODEL` | the smoke test | `acestep-5Hz-lm-0.6B` |

## Verifying it end to end

```bash
node scripts/test-ace-step-bos-toxic.mjs
```

Checks the backend is up, submits the Bos Toxic style and lyrics in Indonesian
with a male vocal, polls to completion, downloads the WAV into `evaluation/`
(gitignored), and prints the models that ran, the wall-clock generation time and
the length of the result. Exits non-zero if any of that fails.

The mocked half of the same case lives in `tests/unit/neural.test.ts` and runs in
CI, where there is no GPU and no multi-gigabyte download.

## Deployment

**GitHub Pages cannot run ACE-Step.** Pages serves static files; it has no
process, no GPU and no Python. The deployed site at
`jamalbalya.github.io/aimusicgenerated` therefore runs the offline procedural
engine, and shows the neural engine as Not Connected unless the person visiting
has a backend of their own reachable from their browser.

For a public neural deployment:

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

`node scripts/test-ace-step-bos-toxic.mjs` is the step that closes that gap, and
it is written to fail loudly rather than pass vacuously. Until it has been run
and the audio listened to, no quality claim about the neural path should be made
— including by this repository's own documentation.

## Limitations

- No cancellation on the server side; see above.
- ACE-Step's queue runs one worker: `ACESTEP_QUEUE_WORKERS` is documented as
  single-GPU, so several takes are generated one after another, not at once.
- Stems, MIDI export and the chord chart are features of the **procedural**
  engine, which has a score behind it. A neural result is a finished recording;
  there is no arrangement to export.
- Nothing in this document claims a quality result. The neural path's audio has
  to be generated and listened to before anything is said about how it sounds.
