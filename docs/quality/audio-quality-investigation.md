# Investigating a song that sounds wrong

A song can sound unharmonious for reasons that have nothing to do with each
other — a melody fighting the chords, a vocal buried under the band, lyrics
packed too tightly to breathe, an arrangement that peaks in the wrong place.
Listening tells you something is wrong. It does not tell you which.

`poc/audio-quality/analyze.py` measures the things that can be measured and
marks the ones that cannot be trusted on their own.

```bash
pip install numpy scipy soundfile librosa        # required
pip install demucs                               # optional, and much better

python poc/audio-quality/analyze.py song.wav
python poc/audio-quality/analyze.py take1.wav take2.wav take3.wav --json out.json
python poc/audio-quality/analyze.py song.wav --require-demucs
```

Output marks every figure `measured` (the file states it), `estimated` (a method
produced it, and the method can be wrong) or `unavailable`. Estimates print
their own caveat. Read the caveat before quoting the number.

## Why several takes

ACE-Step on the ZeroGPU Space draws a new random seed for every request
(`GenerationConfig(use_random_seed=True)` in `poc/zerogpu-space/app.py`), and
the endpoint accepts no seed, so two runs of the same brief are different songs.
Any difference between one take and one other take is therefore unattributable:
it may be the setting you changed, or it may be the seed.

So the protocol is: **hold everything constant and generate at least three
takes**, then change one thing and generate three more. The spread within a
group is the model's own variance. A setting has to move a number further than
that spread before it has demonstrably done anything. `analyze.py` prints the
across-take comparison for exactly this reason.

## What each measurement is for

| Measurement | Answers | Trust |
|---|---|---|
| `peak_dbfs`, `crest_factor_db`, `clipped_samples` | is it distorted or over-limited | measured |
| `band_energy_percent` | is the frequency balance lopsided | measured; genre-dependent, compare takes |
| `stereo_correlation` | will it survive mono playback | measured |
| `tempo_bpm`, `tempo_spread_bpm` | is the tempo what was asked, and steady | estimated; half/double errors are normal |
| `key_estimate`, `minor_triad_share` | is it dark or bright, and centred | estimated; relative major/minor are routinely swapped |
| `energy_profile_5s`, `loudest_point_s` | does the arrangement build where the lyrics do | measured |
| `voice_to_music_db` | is the vocal buried | estimated; depends on separation quality |
| `vocal_pitch_median_note` | is the voice in the register asked for | estimated; pyin locks onto the 2nd harmonic often enough to matter |
| `melody_harmony_z` | **does the melody follow the chords** | estimated; the one vocal figure worth arguing from |
| `vocal_onset_to_beat_ms` vs `_null_ms` | does the phrasing sit with the beat | estimated; only meaningful if the real figure is clearly below the null |

### The two figures that need their null

`melody_harmony_z` and `vocal_onset_to_beat_ms` are both scored against a null
model: the same melody, or the same onsets, placed against the accompaniment at
the wrong moments. Without that comparison a raw percentage means nothing — 38%
of sung notes landing in the chord sounds low until you know that a melody with
no relationship at all would score 30%.

A `melody_harmony_z` near zero means the melody is genuinely unrelated to the
harmony. Clearly positive means it follows the chords, however loosely.

## Findings on the 2026-09-17 sample

One file, 5:10, supplied by the user. **Its provenance is unconfirmed and two
pieces of evidence suggest it did not come from this project** — the style it was
said to be made from is 1457 characters and the Space refuses anything over 512
with HTTP 400, and its filename follows a convention this app does not use
(`songTitle()` names a song after the first *sung* line, skipping section tags).
Read what follows as an analysis of that file, not as a measurement of this
pipeline's output.

**Verified** (measured, or estimated with the null model beside it):

- 310.03 s, 48 kHz stereo, peak −1.21 dBFS, **0 clipped samples**, crest factor
  14.4 dB — no distortion, not over-limited.
- Tempo steady across the whole file; no drift.
- The loudest moment is at 270 s of 310 s — the arrangement does build to a late
  peak, which is what the brief asked for.
- `melody_harmony_z = +4.35`. The melody is **not** harmonically random. It
  follows the accompaniment, loosely but definitely.
- `vocal_onset_to_beat_ms = 69.7` against a null of 106.5 — the phrasing is
  meaningfully tied to the beat, not floating free of it.
- `voice_to_music_db = −4.81` — the voice sits consistently under the band,
  where a lead vocal would normally sit at or above it.

**Hypotheses, not established:**

- The tonal centre reads B♭ with a 43% minor-triad share, against a brief asking
  for a dark minor centre. Relative major/minor confusion makes this suggestive,
  not conclusive.
- `melody_in_chord_top3_percent = 38.1` is above chance but low. Consistent with
  a melody that floats over the harmony rather than locking to it — but the
  separation leaks, so the figure is soft.
- `vocal_pitch_median_note = G4` looked far too high for the requested heavy,
  deep male voice, until the partial series at 215 s (294 / 441 / 882 Hz) turned
  out to be harmonics of ~147 Hz. **The octave reading is unreliable and no
  conclusion should be drawn from it.**

**Not measurable here:** which words were sung, and whether they landed in their
own sections. That needs transcription, and the model weights for it are not
reachable from the build environment.

## What this cannot tell you

It cannot tell you a song is good. It can tell you that nothing is clipping,
that the melody is or is not related to the harmony, that the voice is or is not
buried, and where the arrangement peaks. Everything past that is taste, and
taste is not a number.
