# Environment variables

The authoritative list. One name per setting; anything not listed here is not
read by this project.

## Neural engine

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `ACE_STEP_API_URL` | scripts, smoke test, **and the browser bundle** | `http://127.0.0.1:8001` | Where the ACE-Step API is |
| `ACE_STEP_API_KEY` | scripts, smoke test, browser bundle | unset | Sent as `Authorization: Bearer`, only when the backend sets `ACESTEP_API_KEY` |
| `ACE_STEP_MODEL` | scripts, smoke test, browser bundle | `acestep-v15-turbo` | DiT checkpoint to request |
| `ACE_STEP_LM_MODEL` | scripts, smoke test, browser bundle | `acestep-5Hz-lm-0.6B` | 5 Hz language model to request |

### Why there is no separate `VITE_` name to remember

Vite only exposes variables prefixed `VITE_` to the browser bundle. Rather than
make every setting exist twice — once for the scripts and once for the app,
free to drift apart — `vite.config.ts` bakes the plain name into the bundle at
build time. Setting `ACE_STEP_API_URL` is enough for both.

`VITE_ACE_STEP_API_URL`, `VITE_ACE_STEP_API_KEY`, `VITE_ACE_STEP_MODEL` and
`VITE_ACE_STEP_LM_MODEL` still work and take precedence, for anyone who prefers
to be explicit. They are overrides, not a second requirement.

Because these are baked in at build time, changing one means rebuilding
(`npm run build`) or restarting `npm run dev`.

## Where things live on disk

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `ACE_STEP_HOME` | scripts, smoke test | `~/Applications/ACE-Step-1.5` | The ACE-Step source checkout |
| `ACE_STEP_MODELS` | scripts, status | `~/Models/ACE-Step-1.5` | The model weights |
| `ACE_STEP_HOST` | scripts | `127.0.0.1` | Host the backend binds |
| `ACE_STEP_PORT` | scripts | `8001` | Port the backend binds |
| `ACE_STEP_DOWNLOAD_SOURCE` | setup | `auto` | `auto`, `huggingface` or `modelscope` |

`ACE_STEP_API_URL` is derived from `ACE_STEP_HOST` and `ACE_STEP_PORT` when it
is not set explicitly.

A leading `~` is expanded by the scripts themselves: a value read out of a
`.env` file is not expanded by anything else, and would otherwise be taken as a
directory literally named `~`.

## Smoke-test tuning

| Variable | Default | What it does |
|---|---|---|
| `ACE_STEP_POLL_MS` | `3000` | How often the smoke test polls |
| `ACE_STEP_TIMEOUT_MS` | `2700000` | How long it waits before giving up (45 min) |

## Variables belonging to ACE-Step itself

These are **ACE-Step's**, not this project's. The start script exports them so
its own launcher picks up the right models and directory; they are listed here
so it is clear which side of the boundary each one lives on.

| Variable | Set by | Value |
|---|---|---|
| `ACESTEP_CHECKPOINTS_DIR` | `ace-step-env.sh` | `$ACE_STEP_MODELS` |
| `ACESTEP_LM_MODEL_PATH` | `start-ace-step-macos.sh` | `$ACE_STEP_LM_MODEL` |
| `ACESTEP_LM_BACKEND` | `start-ace-step-macos.sh` | `mlx` |
| `TOKENIZERS_PARALLELISM` | `start-ace-step-macos.sh` | `false` |

Note the near-collision: **`ACE_STEP_LM_MODEL`** is this project's setting, and
**`ACESTEP_LM_MODEL_PATH`** is ACE-Step's. The first is translated into the
second by the start script. Nothing in this repository reads `ACESTEP_*` except
`scripts/ace-step-env.sh`, which only passes them through.

## Not neural

| Variable | Read by | What it does |
|---|---|---|
| `VITE_INLINE_WORKER` | build | Set by the single-file build; not a user setting |

## Precedence

For every setting: **real environment → `.env` at the repository root →
default**. `.env` is gitignored; `.env.example` documents the lot.

```bash
cp .env.example .env
```
