# Environment variables

The authoritative list. One name per setting; anything not listed here is not
read by this project.

## Neural engine

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `ACE_STEP_BACKEND` | browser bundle | `local` | Which neural backend the studio talks to: `local` or `zerogpu`. Anything else is reported as a configuration error, never read as `local` |
| `ACE_STEP_MODEL` | scripts, smoke test, browser bundle | `acestep-v15-turbo` | DiT checkpoint. The local backend requests it; the ZeroGPU backend checks the Space ran it |
| `ACE_STEP_LM_MODEL` | scripts, smoke test, browser bundle | `acestep-5Hz-lm-0.6B` | 5 Hz language model, requested or checked the same way |

### ZeroGPU backend (`ACE_STEP_BACKEND=zerogpu`)

| Variable | Default | What it does |
|---|---|---|
| `ACE_STEP_SPACE_URL` | unset — **required** | The Space's own host, `https://<owner>-<space>.hf.space`. Not its huggingface.co page, and no path |
| `ACE_STEP_SPACE_AUTO_DURATION` | `271` | Seconds that "Auto" length becomes. The Space has to be told a length, and 271 is the full song validated end to end on the live Space. 10–600 |
| `ACE_STEP_SPACE_MAX_DURATION` | unset | Requests longer than this are refused before anything is sent. Unset means no ceiling is claimed — **not** that any length fits the Space's GPU time. 10–600 |
| `ACE_STEP_SPACE_TIMEOUT_SECONDS` | `900` | Outer bound on one generation, queue and a cold start included. A dead connection is caught much sooner, by the heartbeat. 60–3600 |

No token is configured here, and none can be. There is no variable that would
bake a Hugging Face token into the bundle — a personal access token in a public
bundle is a published credential, so the door is simply not there. The only
credential the frontend ever carries is an OAuth access token the visitor
obtained by signing in themselves, held in memory for that one tab. A token used
to *push* the Space (`poc/zerogpu-space/deploy.sh`) may live in `.env`; it is
never baked, because only the variables named on this page are.

A value that is present but invalid — a duration that is not a whole number, a
Space page URL instead of its host, an `http://` Space on the `https://` site —
is not replaced by a default. It becomes the reason shown next to "Neural
Engine: Not Connected", so the build that is wrong says so.

### Local backend (`ACE_STEP_BACKEND=local`)

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `ACE_STEP_API_URL` | scripts, smoke test, **and the browser bundle** | `http://127.0.0.1:8001` | Where the ACE-Step API is |
| `ACE_STEP_API_KEY` | scripts, smoke test, browser bundle | unset | Sent as `Authorization: Bearer`, only when the backend sets `ACESTEP_API_KEY` |

### The public site

`.github/workflows/deploy.yml` builds with `ACE_STEP_BACKEND=zerogpu` and takes
the rest from **repository variables** — Settings → Secrets and variables →
Actions → Variables:

| Repository variable | Required | Value |
|---|---|---|
| `ACE_STEP_SPACE_URL` | yes | `https://<owner>-<space>.hf.space` |
| `VITE_HF_CLIENT_ID` | yes | the Hugging Face OAuth application's client id |
| `ACE_STEP_BACKEND` | no | overrides `zerogpu` |
| `ACE_STEP_SPACE_AUTO_DURATION`, `ACE_STEP_SPACE_MAX_DURATION`, `ACE_STEP_SPACE_TIMEOUT_SECONDS` | no | as above |

Variables, not secrets: every one of them ends up in a public bundle. If
`ACE_STEP_SPACE_URL` is missing the deploy still runs, puts a warning in the
workflow summary, and the site's neural engine says it is not configured.

`VITE_HF_CLIENT_ID` behaves the same way, and matters as much: without it the
site builds and every offline tool works, but the neural engine is unusable —
the studio says signing in is not configured and nothing can be generated,
because the Space refuses a request that carries no verified account. The
workflow warns in its summary rather than failing, so a deploy that is missing
it is visible rather than silent.

It is the **public client** id of an OAuth application, and public is the whole
point: a public client has no secret, and every OAuth flow there is sends this
value to the browser in the authorization URL. Which is why it is a *variable*
and not a *secret*, and why finding it in the bundle is expected rather than a
leak. There is no client secret in this project — not in the workflow, not in
the bundle, not in `.env`. If an OAuth application hands you one, it does not
belong here; this is an Authorization Code + PKCE flow, which exists precisely
so that a browser client needs no secret.

The allowlist deciding who may actually generate is **not** here. It lives in
the Space as `ALLOWED_HF_USERS`, where the browser cannot read or change it.
Signing in proves who you are; the Space alone decides what that entitles you
to. Nothing in this table is a security control: the gate is the Space's, and
the studio's own refusal of a signed-out visitor is a courtesy in front of it.

### The Space's own variables

These are set as **Space secrets** on Hugging Face, never in this repository and
never in a bundle. They are listed here because they decide what the frontend's
requests meet; `poc/zerogpu-space/README.md` is the fuller account.

| Space secret | Default | What it does |
|---|---|---|
| `ALLOWED_HF_USERS` | unset | Who may generate, checked after the sign-in is verified. **Unset means nobody** — it fails closed |
| `RATE_LIMIT_REQUESTS` / `RATE_LIMIT_WINDOW_SECONDS` | `6` / `3600` | Abuse brake per **verified user**, never per address |
| `OPENID_PROVIDER_URL` | `https://huggingface.co` | Where identity is checked |
| `AUTH_CACHE_SECONDS` | `60` | How long a verified token is trusted before Hugging Face is asked again |

`REQUIRE_HF_SIGN_IN=1` is set as a Space **variable** and is documentation
rather than a switch: `guard.sign_in_required()` is unconditionally true, so a
deployment cannot turn the sign-in off — setting it to `0` changes nothing and
the Space says so in its startup log. Anonymous requests get 401 before any
handler runs.

### Why there is no separate `VITE_` name to remember

Vite only exposes variables prefixed `VITE_` to the browser bundle. Rather than
make every setting exist twice — once for the scripts and once for the app,
free to drift apart — `vite.config.ts` bakes the plain name into the bundle at
build time. Setting `ACE_STEP_API_URL` is enough for both.

It reads them with Vite's `loadEnv`, which is what makes a value in `.env`
actually arrive. Until this was fixed, the config read `process.env`, where Vite
never puts a `.env` file's plain keys, so only variables exported in the shell
were baked — and a `.env` value, `VITE_` form included, was silently dropped.

The `VITE_ACE_STEP_*` form of every name still works and takes precedence, for
anyone who prefers to be explicit. A blank value counts as unset.

Because these are baked in at build time, changing one means rebuilding
(`npm run build`) or restarting `npm run dev`. Unit tests bake nothing, so a
`.env` pointing at the live Space cannot change what they see, and the E2E suite
blocks `*.hf.space` so it can never submit a real job.

## Where things live on disk

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `ACE_STEP_HOME` | scripts, smoke test | `~/Applications/ACE-Step-1.5` | The ACE-Step source checkout |
| `ACE_STEP_MODELS` | scripts, status | `~/Models/ACE-Step-1.5` | The model weights |
| `ACE_STEP_HOST` | scripts | `127.0.0.1` | Host the backend binds |
| `ACE_STEP_PORT` | scripts | `8001` | Port the backend binds |

`ACE_STEP_API_URL` is derived from `ACE_STEP_HOST` and `ACE_STEP_PORT` when it
is not set explicitly.

There is deliberately no download-source setting. ACE-Step's `acestep-download`
accepts only `--model`, `--all`, `--list`, `--dir`, `--force`, `--token` and
`--skip-main`; its `main()` never passes `prefer_source` through, so the
downloader always auto-detects between HuggingFace and ModelScope whatever you
ask for. A variable that silently did nothing would be worse than none.

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
