# Audio quality analysis

Offline measurement tools for songs this project generates. Nothing here is
imported by the web application, nothing here is bundled, and nothing here costs
money to run. It is a separate program you run deliberately, on your own machine,
on a file you already have.

```
python analyze.py song.mp3 [more.wav ...] [--json out.json]
```

---

## The two conditions

A generated song is only acceptable when **both** of these hold:

**A. The vocal is accurate and stable** across the low, mid and high registers —
notes centred on the twelve-tone grid, no drift across a held note, no broken
register transitions, vibrato in a singer's range rather than a wobble.

**B. The vocal melody is harmonically compatible** with the accompaniment — the
notes it lands on are notes the band is playing under it.

These are different questions and they fail independently. This is the single
most important thing to understand before reading any number this tool prints:

> **Good intonation does not guarantee harmonic compatibility.**
> A vocal can be pitch-accurate to within a few cents and still clash with the
> accompaniment throughout. Intonation asks *did the note land on the grid*;
> compatibility asks *was it the right note*. A wrong note sung perfectly scores
> zero cents of error.

> **Pitch shifting is not the fix when the melody conflicts with the chords.**
> Pitch correction moves a note to the nearest grid position. If the note is
> already there — and a take with good intonation has every note already there —
> correction has nothing to do and changes nothing. Retuning the mix does not
> help either: the vocal is in tune, so "correcting" it either does nothing or
> moves it off the grid it was correctly on. The only repair for a melody that
> does not fit the harmony is a different melody, which means regeneration, not
> post-processing.

`analyze.py` therefore reports a `verdict` that requires both, and refuses to
produce one at all when the vocal could not be isolated.

---

## What it measures, separately

Requirement-by-requirement, each reported as its own figure rather than folded
into a score:

| Measure | Keys in the output |
| --- | --- |
| Vocal intonation | `grid_median_cents`, `grid_bias_cents`, `grid_worse_than`, `note_centre_median_cents`, `note_drift_median_cents`, `note_spread_median_cents`, `notes_drifting_over_50c` |
| Low / mid / high register accuracy | `registers` — one row per band, each with its own note count, seconds, median and worst centre error, and median drift |
| Vibrato stability | `vibrato_rate_hz`, `vibrato_extent_cents`, `vibrato_frames_percent`, `vibrato_notes_with_vibrato`, plus the window and hop it used |
| Register transitions | `large_intervals` — every jump of 7 semitones or more between held notes, with its time and the gap across it |
| Vocal / instrumental contamination | `vocal_isolation`, `separation_method`, `intonation_contaminated`, `harmony_isolated`, `voice_to_music_db` |
| Harmonic compatibility | `harmony_z`, `harmony_mean_support` vs `harmony_mean_support_null`, `harmony_top3_percent` vs `harmony_top3_percent_null`, `harmony_weakest4_percent`, `harmony_in_key_percent`, `harmony_key`, `harmony_clashes`, `harmonic_compatibility` |
| Overall | `verdict` — `PASS`, `PASS_WITH_WARNING`, `REGENERATION_REQUIRED` or `ANALYSIS_UNAVAILABLE` |

### Reading `harmony_z`

The raw "how often was the sung note in the chord" percentage means nothing on
its own — there is no number to compare it against. So the same melody is also
scored against the accompaniment at 40 *wrong* moments, which is what a melody
with no relationship to the harmony would score. `harmony_z` is how many null
standard deviations the real alignment beats that by.

- `z` clearly above 2 — the melody follows the chords.
- `z` near 0 — the melody is statistically indistinguishable from the same line
  sung over the wrong bars. It may still be perfectly in tune.

Read the z. The raw percentage beside it is there only so the z can be checked.

---

## Vocal isolation (optional)

Every vocal figure above is meaningless when measured on a full mix. A pitch
tracker follows whichever harmonic source is loudest, and a tenor saxophone,
piano or upright bass sits in the same register as a male voice. Measuring the
mix and calling the result a verdict on the *voice* is not a conservative
approximation; it is a different measurement wearing the same name.

So isolation is **optional but load-bearing**: when it is not available, the
analysis reports `ANALYSIS_UNAVAILABLE` rather than guessing. It never falls back
to a full-mix number and calls it a PASS.

`separate_vocals.py` drives Spleeter's 2stems checkpoint through TensorFlow. It
is deliberately outside the application:

- TensorFlow and the checkpoint are **never** imported by the browser bundle.
- The 73 MB checkpoint is **not** vendored into this repository.
- Nothing here is installed by `npm install` or required by CI.

### Installing TensorFlow

```
python3 -m pip install 'tensorflow>=2.13' librosa soundfile numpy scipy
```

Verified here with TensorFlow 2.21.0, librosa 0.11.0, NumPy 2.4.6, on CPU. No
GPU is used or needed; a five-minute song separates in a couple of minutes.

The `spleeter` PyPI package itself is **not** required and not installed — only
its published checkpoint is used, driven directly through TensorFlow's v1
compatibility API. That avoids pinning this tool to Spleeter's own (long
unmaintained) dependency set.

### Downloading the checkpoint

```
mkdir -p ~/.cache/aimusicgenerated/spleeter-2stems
curl -L -o /tmp/2stems.tar.gz \
  https://github.com/deezer/spleeter/releases/download/v1.4.0/2stems.tar.gz
tar -xzf /tmp/2stems.tar.gz -C ~/.cache/aimusicgenerated/spleeter-2stems
rm /tmp/2stems.tar.gz
```

The archive is 73,109,797 bytes:

```
sha256  f3a90b39dd2874269e8b05a48a86745df897b848c61f3958efc80a39152bd692
```

It extracts to `checkpoint`, `model.meta`, `model.index` and
`model.data-00000-of-00001`. Only the last three are read.

To keep it somewhere else, set `SPLEETER_MODEL_DIR` to that directory.

### Checking it is there

```
python3 -c "import separate_vocals as s; print(s.availability())"
```

A `ready=False` result says exactly what is missing. That same reason string is
what the analysis prints as `vocal_isolation` when it has to stand down.

### The split is checked before it is trusted

A separator that silently does nothing returns a "vocal stem" that is the whole
mix, and every figure measured on it is a figure about the band.
`separation_quality` catches that by looking at the stem's own quiet moments: a
real vocal stem is near-silent wherever nobody is singing — between phrases,
under an instrumental break, at a breath — while the band plays on through all
of it. A failed split has no such moments, because it inherits the mix's
envelope.

It requires at least 10% of *each half* of the track to sit more than 30 dB
below the stem's own loud level. Measured on two real songs: a working split
reaches 20% and 31%; a failed one manages 2% and 4%. Below the threshold the
analysis reports `ANALYSIS_UNAVAILABLE`.

Both parts of that rule earn their keep. The share catches a stem that is loud
from end to end. The per-half requirement catches a song that opens on silence,
which banks enough quiet to clear a whole-track threshold even when the split
failed. An earlier version of this check compared the opening seconds against
mid-song instead; it assumed every song has an instrumental intro, so it
rejected good splits on songs that sing from the first bar, and the silent-intro
case fooled it the other way. The opening ratio is still reported as a second
opinion, but it no longer decides anything.

---

## Running the tests

```
python3 test_intonation.py
python3 test_separation.py
```

Neither needs the checkpoint or TensorFlow: they build synthetic tones with
known pitch, known vibrato rate and known extent, and check the analyser reports
those values back. `test_separation.py` additionally pins every refusal path —
what happens when TensorFlow is missing, when the checkpoint is incomplete, when
the split fails its quality check — so the "stand down rather than guess"
behaviour cannot be regressed away.

---

## What these numbers cannot do

- They cannot prove a song sounds good. They can prove specific things are
  wrong, and they can fail to find anything wrong.
- Key and chord estimates are template matches over a dense mix. They confuse a
  key with its relative minor and read a loud sustained bass note as a root.
- `grid_median_cents` is bounded to ±50 by construction — a note 70 cents sharp
  reads as 30 cents flat. It cannot detect wrong notes. That is what the
  harmonic pass is for.
- Chroma comes from a polyphonic mix, so a chord tone the band implies but never
  sounds counts as absent.
- Passing every test here does not prove a real generated vocal is free of pitch
  errors. It proves the analyser measures correctly what it claims to measure.
