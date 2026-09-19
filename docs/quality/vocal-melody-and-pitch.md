# The target melody and the vocal pitch pipeline

A review of the architecture that decides what the vocal *should* sing and then
holds the returned vocal to it, the defects that review found, and what each one
was replaced with. Every number below was measured by a script in this
repository; none is an estimate.

## Why a target melody exists at all

You cannot correct a pitch without knowing what it should have been.

Correcting each note to its own nearest semitone is not pitch correction. A
wrong note sung perfectly in tune is already on a semitone, so snapping it to
itself changes nothing and reports success. Deviation from the *nearest*
semitone is bounded to ±50 cents by definition, which means a measurement built
on it cannot distinguish a flawless performance of the wrong melody from a
flawless performance of the right one. That is not a hypothetical; it is the
failure this project measured on a real song and spent a long time chasing.

So the reference is derived musically, before anything is generated:

    key -> progression -> chord per bar -> section shape -> phrase contour
        -> syllable rhythm -> note -> frequency

Nothing in that chain reads the generated audio, which is the point: the audio
is the thing being judged, so it cannot also be the standard.

**ACE-Step never sees this melody.** `text2music` has no melody input and
`constraints.ts` files melody under `NOT_CONTROLLED_BY_ACE_STEP`. The melody is
the reference the returned vocal is measured and corrected against, not a
request. Its value is that it is musically defensible, not that it is
transmitted.

## What the first implementation got wrong

It wrote one note per syllable, always, over the tonic triad, always.

| # | Defect | Consequence |
| --- | --- | --- |
| 1 | Syllables were a section's total divided by its line count | A 3-syllable line and a 12-syllable line got the same notes; `note.syllable` was `''` on every note of every song |
| 2 | One chord — the tonic triad — for the whole song | "Resolve to a chord tone" meant the tonic triad over a ♭VI, so correction would have dragged a correctly sung vocal onto the wrong note |
| 3 | Beats accumulated fractionally and never reset to a bar line | `beat % 4 === 0` was false after the first line, so the downbeat rule silently never fired again |
| 4 | Note choice minimised distance from the previous note | Which selects the previous note whenever its pitch class is a candidate: the line repeated notes and did not move |
| 5 | Verse and chorus differed only by a centre shifted ~2 semitones | And the distance term outweighed it, so they sounded the same |
| 6 | Exactly one note per syllable | No melisma, no sustained vowel, no breath, no rest, no phrase that holds its last note |

## What replaced it

**Harmony first** (`src/engine/live/songHarmony.ts`). A real progression per
section, one chord per bar, using the offline engine's own progression library,
mode filter and roman-numeral reader — the same code that carries the fixes for
gapped scales and for numerals transposed into the wrong mode. Sections of the
same kind share a progression, which is what makes every chorus land on the same
harmony.

**Real syllables.** Each written line is pronounced by the project's own
multilingual syllabifier, so every note carries its syllable text, its vowel,
the line it came from, and how long its consonant onset lasts.

**Per-section shapes.** A verse is narrow, low and conversational because it
carries the story; a chorus is higher, wider and repeats itself because it
carries the hook; a pre-chorus rises and ends unresolved; an outro falls and
settles. Five phrase contours (arch, ascend, descend, wave, plateau) are sampled
across a line's syllables and realised against the chord under each note.

**A motif store**, keyed by section kind and the line's position inside it, so
the second chorus's third line sings the first chorus's third line — ornaments
included. The last chorus is lifted and its first note is taken to the highest
chord tone in range: one climax, once in the song.

**A richer schema.** Time (beat, bar, seconds), pitch (MIDI, frequency, scale
degree), lyric (syllable, line, vowel, onset seconds, whether the onset is
unvoiced), structure (phrase, position, phrase boundaries, section), harmony
(chord pitch classes, chord name, chord-tone flag), and interpretation (role,
transition, tolerance).

**Eight roles, not two.** `anchor`, `resolution`, `suspension`, `approach`,
`neighbour`, `passing`, `melisma`, `rest` — each with its own tolerance, because
holding a passing note to a cadence anchor's 35 cents buys nothing a listener
can hear and costs the performance its phrasing.

### Measurements that drove the design

Each of these changed the code, and each was found by running it rather than by
reading it.

| Observation | Change |
| --- | --- |
| 59% of a ballad's notes came out as `anchor`, two of them not chord tones | `classify` reduced to three cases; the "long chord tone" and "cadence bar" promotions removed |
| Suspensions were unreachable — every strong note was chord-snapped | `applyCadentialSuspension` writes one deliberately into each phrase that can carry it |
| A five-syllable outro over eight bars gave the last syllable **14 beats** | Note length capped, and time left over becomes a rest |
| Capping at a whole bar still put 93% of a sparse sheet's notes on downbeats | Syllables are sung at a natural rate (0.42 s each) and the surplus is silence |
| A chorus repeat shared as little as none of its contour | Melisma decisions stored with the motif, so a repeat repeats its ornaments |
| Notes sustained across bar lines into a different chord | `holdableBeats` stops a note at the bar line unless the next bar carries the same chord |

Anchor share across six configurations (two sheets × three durations) is now
29–38%, stable, where it previously ranged 29–93% with the length of the song.

## The pitch-shifting method, re-evaluated

`poc/zerogpu-space/bench_shifters.py` scores five methods on ten properties
against a reference that is the same synthetic voice genuinely produced at the
target pitch — because comparing a shifted signal with its own *input* is
invalid: the harmonics have moved across fixed formant peaks, so the spectrum is
supposed to change. It also scores a control that applies no shift, which is
what makes the other rows readable.

```
method           cents  oct  centroid%  formant%   flux  HNRloss  len  vib%  onset%
none (control)    67.5    0        1.4      14.1    277      n/a  yes   100     100
varispeed          2.1    0        7.7      11.3   1113     21.0  yes   108      99
varispeed-poly     2.1    0        7.5      11.7   1110     25.0  yes   108      93
td-psola           2.1    0        9.3      13.5    274     54.9  yes   108      83
phase-vocoder      2.1    0       31.6      47.4   2709     36.6  yes   108     959
hybrid (shipped)   2.1    0        5.1      13.7   1150     21.0  yes   108     105
```

Read with the control in hand:

- **`formant%` cannot separate them.** A signal whose formants provably did not
  move scores 14.1, so 11.3, 13.5 and 13.7 are all at the estimator's noise
  floor. Only the phase vocoder's 47.4 is a real result. Citing 11.3 against
  13.7 would have been reading noise as evidence.
- **`centroid%` can.** Its floor is 1.4. The hybrid sits at 5.1 against
  varispeed's 7.7, so the excess over the control falls from 6.3 to 3.7 — about
  two fifths of the formant drift genuinely removed.
- **Everything else ties or loses elsewhere.** The hybrid matches varispeed
  exactly on pitch error, octave errors, harmonic structure, vibrato and
  duration. TD-PSOLA is the steadiest spectrum on the bench and pays 54.9 dB of
  harmonic-to-noise for it, which is what "processed" sounds like.

**Shipped: varispeed followed by one static formant-restoration filter**,
`H(f) = Env(f) / Env(f/ratio)`, computed once per note from the note's own
averaged spectral envelope and applied zero-phase. One FFT per note, no new
dependency.

WORLD is absent deliberately: it is a new binary dependency on a Space whose
premise is that it installs nothing beyond ACE-Step's own requirements. If a
method on the bench were failing, that trade would be worth reopening. None is.

Three conclusions in this area have now been wrong, all the same way — argued
from theory, measured afterwards:

1. TD-PSOLA "preserves formants": measured 34% centroid drift in the same
   direction whichever way the pitch went, which is grain-join noise.
2. The hybrid's per-frame envelope correction: compared the source frame at
   offset *t* with the shifted frame at offset *t*, but varispeed maps output
   time *t* to input time *t·ratio*. Measured 31.8% — worse than doing nothing.
3. The `flux` column was supposed to show FFT-resample edge ringing: a polyphase
   variant with no periodicity assumption scores 1110 against 1113.

## Alignment

The greedy maximum-overlap matcher was replaced with a two-level monotonic
alignment: the performance's phrases (found at its own breaths) are matched to
the plan's phrases, and inside each matched pair the notes are matched the same
way. Both are a shortest path over the (measured, planned) grid with three
moves — match, skip a measured note, skip a planned one.

Greedy matching had two real failures. Two sung notes could claim the same
planned note, so one was corrected toward a pitch belonging to the other. And
when the performance ran late — which it does, because ACE-Step has never seen
the plan — the pairs crossed: sung note 7 took planned note 8 while sung note 8
took planned note 7, and correction then moved both the wrong way. Monotonicity
makes both impossible by construction.

## Honest limits

- **A note sung in the wrong octave is reported, never corrected.** It is not
  mistuned, it is a different note; a 1200-cent shift would be a larger edit
  than the error, and nothing here can make ACE-Step have sung the right one.
  The deviation is octave-folded for judging and the fold is counted separately,
  so an octave error can never be reported as "in tune".
- **A note more than 120 cents out is reported, never corrected**, for the same
  reason.
- **A consonant is never pitch-shifted.** The plan says how long each syllable's
  onset is and correction starts after it.
- **A correction that made things worse is reverted** and the original vocal
  returned. Measured on the output, not predicted from the corrections applied.

## Runtime

ZeroGPU hands a Space a bounded slice and takes the GPU back at the end of it.
This stage runs *after* a generation that has already spent most of that slice,
so the question is not how fast it is but whether the song comes back at all.
Measured on a 209-second vocal stem at 44.1 kHz, 418 planned notes, 38 phrases,
on CPU:

| stage | seconds |
| --- | --- |
| `detect_f0` (runs twice: decide, then verify) | 8.9 |
| `segment_notes` | 0.1 |
| `align` (phrase + note DP) | 0.0 |
| shifting 35 notes | 0.2 |
| **`correct_vocal` total** | **9.2** |
| `separate` (Hybrid Demucs) | not measured — no torchaudio here |

It was **107 seconds** before YIN's difference function was computed by FFT,
which would have exceeded the whole slice on its own. `report.stage_seconds`
carries the real figures back with every song, so the estimate is replaced by a
measurement the first time this runs for real.

## Verification status

**OFFLINE DSP VERIFIED ≠ REAL ACE-STEP SONG VERIFIED.** This distinction is not
a formality and it has not changed.

What is verified, by 67 checks in `poc/zerogpu-space/test_vocal_pitch.py`
against signals whose pitch is known to the cent:

- F0 detection from 98 Hz to 659 Hz, within 0.5 cents
- Octave regression: eight cases including a weak fundamental, a strong second
  harmonic, 6 dB SNR, a very quiet note, vibrato and a three-second sustain
- Unvoiced regression: fricatives, silence, a quiet noise floor, a click, and a
  noise burst between two notes
- A consonant onset returned bit-identical while the vowel after it is corrected
- Phrase grouping at breaths but not at consonants
- Monotonic alignment: no crossed pairs, no target claimed twice
- Octave errors and beyond-correction errors counted and not corrected
- A whole synthetic performance at ±10, ±25 and ±50 cents, with a rest, a
  vibrato sustain, a passing note and a trailing consonant, corrected in one
  pass

What is **not** verified and cannot be from this environment:

- **Hybrid Demucs separation has never executed.** `torchaudio` is not installed
  here. `readiness()` reports this rather than assuming it.
- **No real ACE-Step vocal has been touched.** The gateway returns
  `CONNECT tunnel failed, response 403` for both `huggingface.co` and
  `*.hf.space`. No credentials were used and no GPU was spent.
- **Whether the result sounds right**, which needs ears on a real song.

The requirement "no audible fals" is therefore **not met and not measurable from
here**. What has been built is the machinery that makes it measurable, and the
evidence that the machinery is correct on signals where the answer is known.

## Running the evidence yourself

```
python3 poc/zerogpu-space/test_vocal_pitch.py    # 67 checks, no GPU, no network
python3 poc/zerogpu-space/test_guard.py          # the Space's request gate
python3 poc/zerogpu-space/bench_shifters.py      # the five-method comparison
python3 -c "import sys; sys.path.insert(0,'poc/zerogpu-space'); \
            import vocal_pitch, json; print(json.dumps(vocal_pitch.readiness(), indent=2))"
npx vitest run tests/unit/live-pipeline.test.ts  # 84 checks on the planner side
```
