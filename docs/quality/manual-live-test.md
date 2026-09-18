# Testing the live neural path by hand

Everything in this document is for **you** to run. No live generation was run
from the development environment, no ZeroGPU quota was spent, and no Hugging
Face token was used — the Space is not even reachable from there.

---

## What the app does on its own

You do three things:

1. Enter **Style**.
2. Enter **Lyrics**.
3. Press **Generate song**.

Everything else is automatic and has no settings. You are never asked for a key,
a scale, a chord, a vocal range, a seed, a threshold, an attempt count, a
separator, or an analysis option. In Neural mode the controls that the engine
cannot use — genre, mood, tempo, root note, scale, singing voice, seed, stems —
are visibly disabled with one line explaining why.

---

## Offline Procedural Mode — the gate runs end to end

This is the path where the whole gate is real, because the engine's own score is
exact: the notes and the chords are the same object the renderer plays.

**Steps**

1. Open the studio and sign in.
2. Leave the engine on **Offline Procedural**.
3. Type any style, e.g. `dangdut koplo sarcastic workplace anthem`.
4. Paste your lyrics.
5. Press **Generate song**.

**What you should see**

A panel headed **Musical quality gate** above the player, with one of:

| On screen | Meaning |
| --- | --- |
| `Quality gate passed` | Delivered. The melody fits the chords. |
| `Not verified — review required` | Inside every threshold but genuinely ambiguous. Not presented as a pass. |
| `Regeneration required` | Nothing was delivered. Press Generate again. |

Expand **attempts** in the panel to see the log:

```
Attempt 1 → REGENERATION_REQUIRED → reject
Attempt 2 → REGENERATION_REQUIRED → reject
Attempt 3 → PASS → deliver
```

Rejected takes are **never** opened and **never** appear in the take chooser.
They are discarded, not hidden.

If all ten attempts fail:

```
Generation failed the musical quality gate after 10 attempts.
No incorrect audio was delivered.
```

Measured on 20 prompts × 10 seeds: 58% of takes pass, and 23 runs in 24 deliver
a song within the attempt budget. Roughly 1 run in 25 will show the failure
message — press Generate again.

---

## Neural Mode — what to expect, and what it will *not* say

**Steps**

1. Switch the engine to **Neural**.
2. Enter Style and Lyrics.
3. Press **Generate song**.

**What you should see**

The song generates and plays, and the gate panel says:

```
Musical quality gate
Not verified — analysis unavailable
```

with the reason: judging a melody against chords needs the vocal on its own, and
no vocal separator runs in a browser at this size.

**This is correct behaviour, not a bug.** It will never say `Quality gate
passed` for a neural take, because the browser cannot earn that claim. What it
guarantees is narrower and worth stating exactly:

- It never claims a neural song passed.
- It never rejects one either — `ANALYSIS_UNAVAILABLE` is not a rejection.
- It does not burn attempts regenerating, because regenerating cannot make a
  take analysable. One request, one song, one honest label.

Measuring the mix instead was tried and measured **backwards**: on one real song
the full mix scored z = +6.46 (reads as "the melody follows the chords closely")
while the separated stems scored z = −2.49 (worse than chance). A gate that can
return a confident pass on a song that should be rejected is worse than no gate.

### Getting a real verdict on a neural song

Download the song, then on your Mac:

```
cd poc/audio-quality
python3 -m pip install 'tensorflow>=2.13' librosa soundfile numpy scipy
mkdir -p ~/.cache/aimusicgenerated/spleeter-2stems
curl -L -o /tmp/2stems.tar.gz \
  https://github.com/deezer/spleeter/releases/download/v1.4.0/2stems.tar.gz
tar -xzf /tmp/2stems.tar.gz -C ~/.cache/aimusicgenerated/spleeter-2stems
rm /tmp/2stems.tar.gz

python3 -c "
import sys; sys.path.insert(0,'.')
from pathlib import Path
import gate
r = gate.judge(Path('your-song.wav'))
print(r.verdict)
for reason in r.reasons: print(' -', reason)
print(r.measurements)
"
```

**Expected output shape** — this is a real run on a real song:

```
REGENERATION_REQUIRED
 - The melody is not demonstrably related to the accompaniment (z = -0.38; ...)
 - 31.2% of sung frames sit on pitch classes among the band's four weakest ...
 - 12 clash(es) run longer than 2s, above the 0 allowed.
 - Pitch correction cannot fix this: the notes are on the grid and simply do
   not fit the chords under them.
{'harmony_z': -0.38, 'grid_median_cents': 6.2, 'harmony_in_key_percent': 95.1, ...}
```

Note what that says: **6.2 cents median tuning error and 95.1% of notes in key**
— the vocal is in tune and in the right key — and the melody still does not fit
the chords. That is the failure this whole system exists to catch.

`PASS` looks like:

```
PASS
 - Melody follows the harmony (z = +3.10), median tuning error 7.4 cents,
   no clash longer than 2s.
```

### Fully automatic enforcement for the neural path

`generate_gated.py` is the same loop against your Space: generate → separate →
analyse → reject → regenerate, keeping only a passing take and **deleting** the
rejected audio rather than shelving it.

```
python3 -m pip install gradio_client
python3 generate_gated.py \
  --style-file style.txt --lyrics-file lyrics.txt \
  --space-url https://<owner>-<space>.hf.space \
  --out song.wav --attempts 3
```

**This has never been run against a live Space.** It is tested against a stub
only. Start with `--attempts 3` so a first run cannot spend much quota.

---

## The live-generation switch

A build only calls the Space when it has been told it may:

```
ACE_STEP_LIVE_GENERATION_ENABLED=true
```

- **Off unless explicitly on.** An unset variable, a typo, and a deliberate
  `false` all mean off — each is a case where nobody decided to spend the
  allowance.
- **The deployed site sets it on**, so the normal workflow is unaffected: open
  the site, sign in, generate.
- **A local checkout has it off**, so running this repo cannot spend your GPU
  time by accident. Pressing Generate in Neural mode says so and sends nothing.

To generate from a local build, put `ACE_STEP_LIVE_GENERATION_ENABLED=true` in
`.env` and rebuild. To deploy a site that *cannot* generate — while the Space is
down, or the quota is spent — set the repository variable
`ACE_STEP_LIVE_GENERATION_ENABLED` to `false`.

---

## How to report a failure

For anything that looks wrong, the useful report is:

1. **Which engine** — Offline Procedural or Neural.
2. **The Style and Lyrics**, verbatim.
3. **The verdict line** from the gate panel.
4. **The attempt log**, expanded.
5. **The measurements block**, expanded.
6. **Where it sounds wrong**, in seconds — the panel's *Where it goes wrong*
   list gives timestamps; say whether they match what you hear.
7. For a neural song, the **`gate.judge` output** from the command above.

The most valuable report is a disagreement: a song the gate **passed** that
sounds wrong to you, or one it **rejected** that sounds fine. The first means a
threshold is too loose or a rule is missing; the second means a rule is too
strict. Both are fixable, and neither is visible without a listener.

The least useful report is "it failed the gate" without the panel contents — the
whole point of the panel is that every verdict states the number it came from.
