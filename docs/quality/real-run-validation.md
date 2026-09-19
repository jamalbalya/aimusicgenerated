# Running the real ACE-Step validation

**This repository's environment cannot perform it.** The gateway answers
`CONNECT tunnel failed, response 403` for `huggingface.co` and every `*.hf.space`
host, and `torchaudio` is not installed, so Hybrid Demucs has never executed
here. Nothing in this document is a claim that the real validation happened.
This is how to make it happen somewhere that can.

## What it proves, and what it cannot

It proves that one Generate produces one ACE-Step request and one song, that the
vocal pipeline runs inside the budget, and what the pitch of a real ACE-Step
vocal measures before and after correction.

It does **not** prove the song has no audible out-of-tune note. Nothing that
analyses audio can prove that. `analysis != listening`, and the script says so
in its own output every time it runs.

## Option A: the repository's own CI runner

A GitHub runner has open egress and `ACE_STEP_SPACE_URL` is already configured
for the deploy, so the nearest environment that can do this is the repository's
own Actions.

**Actions → Real ACE-Step run → Run workflow.**

It is `workflow_dispatch` only: no push trigger, no schedule. Adding the file
spends nothing; pressing the button spends exactly one generation.

One thing has to be added first, and only the owner can add it:

> **Settings → Secrets and variables → Actions → Secrets → `HF_TOKEN`**
> A Hugging Face access token for an account in the Space's `ALLOWED_HF_USERS`.
> Read scope is enough — it is only used to prove who is calling.

The Space is private to its own allow-list and refuses any request carrying no
verified account, so without this the run cannot start. The workflow checks for
it in its first step and stops there, because discovering it after the queue
would cost the generation.

Inputs: `duration` (seconds, or `auto`), `vocal_gender`, and `demucs` — set
`demucs: true` to install torchaudio so Hybrid Demucs runs instead of the numpy
fallback. It is slower to set up and the separation is much better, and
`report.separator` names which one ran either way.

The report goes to the run summary; the audio and `report.json` are uploaded as
an artifact kept for 14 days. **That WAV is the only copy** — there is no second
generation to make another.

## Option B: one command, anywhere else

```
export ACE_STEP_SPACE_URL=https://<owner>-<space>.hf.space
export HF_TOKEN=...                      # only if the Space is gated
python3 poc/zerogpu-space/real_run.py --out ./real-run
```

Requires Node (for the request builder) and Python with numpy and scipy. Install
`torchaudio` as well if you want Hybrid Demucs rather than the fallback
separator — the report names which one ran, and every figure depends on it.

Nothing is hardcoded. The Space URL and the token come from the environment or
from flags, and neither is written into the report.

## One generation, by construction

The script posts once and never retries. There is no retry loop, no second
candidate and no "generate again if the first one is bad". If the request fails,
that failure is the result and it is reported as one. A harness that quietly
generated twice would be validating something this product does not do.

The request payload is built by `scripts/build-melody.mjs`, which loads the
engine's own planner, prompt compiler, melody writer and melody validator
through Vite. That is deliberate: it sends *what the browser sends*. A harness
that assembled its own payload would be validating the harness.

## The fixture

`poc/zerogpu-space/fixtures/real-run-{style,lyrics}.txt` is a realistic song:
intro, two verses, two pre-choruses, two choruses, a bridge, a final chorus, an
outro, `[End]`, and an explicit 72 BPM. As compiled by the engine:

| | |
| --- | --- |
| sections | 10 |
| syllables | 240 |
| melody | 246 sung notes, 25 rests, 77 structural, 25 phrases, 62 bars |
| melody validator | 14 checks passed, 0 problems |
| caption | 498 of 512 characters |
| lyric sheet sent | 826 characters, `[End]` the only line withheld |

## Option C: if you already have a real ACE-Step render

The analysis half runs on a file, without generating anything:

```
python3 poc/zerogpu-space/real_run.py --audio-file song.wav --out ./real-run
```

It must be WAV (`ffmpeg -i song.mp3 song.wav`), and the `--style-file` and
`--lyrics-file` must be the ones the song was generated from, or the target
melody will not be the song's melody and every measurement will be meaningless.

The script cannot tell where a file came from, so in this mode it leaves
**TESTED ON REAL ACE-STEP** as `NO` and says the audio was supplied. Classify
that line by hand, from where the file came from. Guessing is the one thing it
must never do.

## What the report contains

The format is fixed:

```
Generation:   one request / one ticket / no regeneration
ACE-Step:     generation duration, audio duration
Vocal:        separation, F0 + alignment + correction, remix, total
Pitch:        planned / measured / coverage, matched, unmatched sung,
              unmatched planned, deviation before and after, octave errors
              before and after, large deviations, corrections applied,
              corrections reverted, per-note regressions
Melody:       validator result, checks passed, problems, whether it was sent
Final audio:  paths written
Listening:    NOT VERIFIED
Classification: IMPLEMENTED / TESTED ON SYNTHETIC / TESTED ON REAL ACE-STEP /
                LISTENING VERIFIED
```

Plus a `Trust:` line — `VERIFIED`, `PARTIAL` or `UNVERIFIED` — and `report.json`
with every per-note row: time, target, role, cents before, cents after, whether
the samples were touched at all, and the decision in words.

**`VERIFIED` is the weakest strong word available.** It means the vocal was
separated, most of the planned melody was found in it, the melody passed its own
checks, and every structural note that could be measured is inside its
tolerance. It does not mean the song has no audible out-of-tune note, and it is
never a listening result.

## Checking the harness without a Space

The analysis path is exercised locally on a rendered file:

```
python3 poc/zerogpu-space/render_synthetic_song.py --out /tmp/render
python3 poc/zerogpu-space/real_run.py --audio-file /tmp/render/mix.wav --out /tmp/check
```

On that deliberately mismatched pairing (a ten-second song against a
three-minute melody) the report reads `Trust: UNVERIFIED — only 3% of the
planned melody was found`, 239 unmatched planned notes, **one** note modified
and **zero** per-note regressions. The one modification was an anchor sung an
octave above the plan, corrected from +900.1 cents to −0.0.

That is the harness working: it refused to claim anything about a song it could
not measure, and the single correction it did make landed.

## The payload is checked against the real gate

The eleven fields go out in the order `app.py` binds them and
`space-info.json` declares them: style, lyrics, language, vocal_gender,
instrumental, duration, bpm, keyscale, timesignature, seed, melody. Verified by
running the built payload through `guard.validate_request` — the same function
the Space runs — in both modes:

```
210 seconds            ACCEPTED   duration=210.0 bpm=72 keyscale='D# Major' melody=7912 chars
Auto (no --duration)   ACCEPTED   duration=-1.0  bpm=72 keyscale='D# Major' melody=7912 chars
duration 0.0           REFUSED    ACE-Step makes songs from 10 to 600 seconds long, ...
```

That third line is a defect this harness had. With no `--duration` it sent
`0.0`, the default of a `.get()`. Zero is not Auto: the guard reads it as a
length, finds it under the ten-second minimum, and refuses. Auto is `-1`, which
is ACE-Step choosing for itself, and it is what the browser sends. The bug would
have spent the one real generation on a 400.

## Readiness

```
python3 -c "import sys; sys.path.insert(0,'poc/zerogpu-space'); \
            import vocal_pitch, json; print(json.dumps(vocal_pitch.readiness(), indent=2))"
```

In this repository's environment it returns `ready: false` with exactly two
problems: no CUDA device, and no `torchaudio`. That is the accurate answer here
and it is not worked around.
