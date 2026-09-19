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

## Large errors are resolved, not reported

An earlier version of this pipeline reported octave errors and deviations over
120 cents and left them in the song. That was wrong against the requirement:
the finished song must contain no audible out-of-tune note, and *too large to
correct* is not a way of meeting it. What replaced it is a strategy chosen by
magnitude and by musical context, not a wider threshold.

**A whole line an octave from the plan is a register, not eleven errors.** The
melody writer picks the octave nearest a section's centre — a preference, not a
requirement — so a line sung entirely an octave away is the singer's register,
consonant with the same harmony. The *plan* is transposed and no audio is
touched. The median across the phrase decides, so it moves with the line and
ignores an outlier.

**A single note out of step with its own phrase is a real error** and is moved
back a full octave, not 92% of one: partial correction is for intonation, and a
register is not intonation. Verified: a note sung an octave below an otherwise
in-register line lands within 0 cents of its target.

**A wrong note — 200 cents or more — is corrected too**, by PSOLA rather than by
the small-shift method.

**Beyond two octaves nothing is corrected**, and the reason given is that the
*alignment* failed. A deviation that large means a sung note was matched to a
planned note that is not its own, and shifting it would turn a matching failure
into an audible one.

## Do no harm

Two rules, because the aggregate one is not enough and this project has the
measurement to prove it.

**Per note.** Every correction is applied, measured on the result, and undone if
it did not land. No note leaves `correct_vocal` further from its target than it
arrived. This exists because on a poorly separated stem the totals improved —
two anchors in tune became three — while one note was destroyed, and a song with
one destroyed note has an audible wrong note in it whatever the average did.

**Per song.** If the corrected stem measures worse overall than the original,
the original is returned unchanged.

Also: a consonant is never pitch-shifted, and a rest is never a correction
target.

## Measuring the result

Verification measures each note **at the boundaries already established**, not
by re-segmenting the corrected stem. Re-segmenting looks more independent and is
worse: the segmenter splits a run of voicing wherever the pitch jumps more than
a tone, so correcting one note to within a tone of its neighbour makes the two
merge, and the merged median is then reported as both of them. Measured: a note
that was +0.1 cents and never touched — the audio around it bit-identical — was
reported afterwards as 156 cents and an octave out, purely because the note
after it had been corrected closer. That was a reporting bug that would have
made every future measurement untrustworthy.

Before and after are computed over **the same set of notes**, using the whole
distance from target including octaves. Excluding octave errors from the
"before" while including the corrected ones in the "after" made one run report
its median *rising* from 0.1 to 2.8 cents while it had in fact fallen from
125.2. Two different sets of notes are not a before and an after.

`measurement_coverage` reports how much of the planned melody was actually found
in the stem. A song where half the planned notes were never located is half
**unmeasured**, not half fine, and the report does not let the two read alike.

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

## Separation without torchaudio

Hybrid Demucs is the separator and it needs torchaudio, which the deployed Space
already pins for ACE-Step. But a pipeline whose single missing dependency
silently disables the whole correction stage is worse than one with a weaker
second path, so there is a fallback in numpy and scipy only: a running median
over about two seconds of the magnitude spectrogram estimates the background — a
pad, a bass line and a drum loop are all still there two seconds later, and a
sung syllable is not — and the vocal is a soft Wiener mask of what the median
cannot explain.

It is **not as good as Demucs** and nothing claims otherwise. `report.separator`
names which one ran, on every song, because every other figure depends on it.
Measured on a mix whose accompaniment is a sustained pad in the same key as the
voice — deliberately the hardest case for this method — the nearest detected
note to the lead is 1902 cents away in the mix and 1 cent away after separation.
On the end-to-end render its signal-to-error ratio against the true stem is
1.89 dB, and coverage is 4 of 8 planned notes: half the song is unmeasured, and
that is the fallback's limit, stated rather than averaged away.

At full resolution it cost 0.36× realtime — 76 seconds for a three-and-a-half
minute song, more than the whole ZeroGPU slice it runs at the end of. The median
is now taken on a spectrogram decimated by 2 in time, which is 3.5× faster for
no measurable loss. The factor is measured, and the first attempt at it was
wrong: the argument that decimation is free (a two-second median cannot contain
finer detail, so sampling it every 93 ms is the estimate rather than an
approximation) ignores that the same window holds *fewer order statistics*
afterwards.

| decimation | seconds | SNR dB | notes measured |
| --- | --- | --- | --- |
| 1 | 2.09 | 2.14 | 4/8 |
| **2** | **0.60** | **1.89** | **4/8** |
| 4 | 0.24 | 1.87 | 3/8 |
| 8 | 0.14 | −6.46 | 3/8 |

Eight is what the free-lunch argument would have chosen, and it loses 8.6 dB and
a quarter of the notes. A 210-second song now separates in 22.6 seconds on CPU
(9.3× realtime); on the deployed Space, Demucs runs on the GPU instead.

## Alignment: three strategies, then a verdict

An alignment failure must not become a corrected vocal presented as finished.
There are three strategies, tried in order, and the best is kept — judged on how
much of the song it matched and how closely, so a later attempt can only help.

1. **Phrase-structured, where the plan says it is.** Usually right.
2. **Phrase-structured, at a global time offset** found by cross-correlating the
   two sets of note onsets. The plan's absolute times are an estimate — the
   melody writer spreads syllables across bars without a forced aligner, and
   ACE-Step has never seen the plan — so a whole performance sitting a second or
   two late is ordinary. One FFT finds the offset; trying every candidate offset
   would mean running the whole alignment once per candidate.
3. **Flat, ignoring phrase structure.** Phrase matching is the better tool when
   the performance's breaths line up with the plan's lines and the worse one
   when they do not: a singer who takes no breath where the plan has one leaves
   the whole song as a single measured phrase against a dozen planned ones.
   Measured on exactly that case: **4 of 12 notes matched with phrases, 12 of 12
   without.** Monotonicity still holds, so this cannot cross two notes.

Afterwards the report carries a trust verdict:

| verdict | meaning |
| --- | --- |
| `UNVERIFIED` | Not enough of the song was measurable to say anything about it. Never upgraded because the corrections that *did* happen went well |
| `PARTIAL` | Measured, with something left in it: an octave error that survived, a match that could not be trusted, a correction that had to be undone |
| `VERIFIED` | Separated, most of the plan found, every structural note that could be measured inside its tolerance |

**`VERIFIED` is the weakest strong word available on purpose.** It says the
measurement found nothing wrong — not that there is nothing wrong, and not that
anybody has listened.

## Status, in four categories that are never merged

| | |
| --- | --- |
| **Implemented** | Harmony-first target melody; 14-check melody validator; monotonic phrase and note alignment; tiered correction (hybrid / PSOLA / phrase re-anchoring); per-note and per-song do-no-harm; consonant-aware shifting; numpy fallback separator; coverage and stage-time reporting |
| **Tested on synthetic / control signals** | 86 DSP checks against signals whose pitch is known to the cent, including a no-shift control that sets each metric's noise floor; 882 unit tests on the planner side; one end-to-end render producing real `.wav` files |
| **Tested on real ACE-Step audio** | **Nothing.** The gateway returns `CONNECT tunnel failed, response 403` for `huggingface.co` and `*.hf.space`. No credentials used, no GPU spent |
| **Listening verified** | **Nothing. REAL AUDIO LISTENING NOT VERIFIED.** `render_synthetic_song.py` writes four `.wav` files; nobody has heard them |

## Verification status

**OFFLINE DSP VERIFIED ≠ REAL ACE-STEP SONG VERIFIED.** This distinction is not
a formality and it has not changed.

What is verified, by 86 checks in `poc/zerogpu-space/test_vocal_pitch.py`
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
- A single note an octave out of its phrase's register corrected back onto the
  planned note; a whole phrase an octave out re-anchored with no audio touched
- No note leaving `correct_vocal` further from its target than it arrived
- The fallback separator isolating the lead rather than the accompaniment, and
  its stems summing back to the mix exactly

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

## The end-to-end render

`render_synthetic_song.py` puts a synthetic mix — a vocal with deliberate,
known errors over a busy backing — through the identical code path a real song
takes, and writes four `.wav` files plus a JSON report. **It is not an ACE-Step
song.** It establishes that every stage executes and that the numbers came from
audio; it establishes nothing about a real ACE-Step vocal, and it is not a
listening test.

The song carries: an in-tune note, a 12-cent sharp passing note, a 48-cent flat
anchor, a 30-cent sharp note with vibrato, a breath, a 250-cent wrong note, and
one note an octave low inside an otherwise in-register line.

| | |
| --- | --- |
| separator | median-filter fallback (no torchaudio here) |
| coverage | 4 of 8 planned notes found — the fallback's limit |
| anchors in tune | 2 → **4 of 4** |
| median deviation from target | 125.2 → **0.7 cents** |
| octave errors | 1 → **0** |
| corrections reverted | 0 |
| peak | 0.849 → 0.810 (never raised) |
| stage seconds | separate 2.77, measure/align/correct 0.34, remix 0.002 |

Per planned note, measured on the audio: the in-tune notes are untouched
(+0.0 → +0.0, +0.1 → +0.1), the 250-cent wrong note lands at −20.4, and the
octave-low note lands at −5.5 in the right octave.

## Running the evidence yourself

```
python3 poc/zerogpu-space/test_vocal_pitch.py    # 86 checks, no GPU, no network
python3 poc/zerogpu-space/render_synthetic_song.py  # end to end, writes real .wav files
python3 poc/zerogpu-space/bench_shifters.py --large # the same bench at octave-sized shifts
python3 poc/zerogpu-space/test_guard.py          # the Space's request gate
python3 poc/zerogpu-space/bench_shifters.py      # the five-method comparison
python3 -c "import sys; sys.path.insert(0,'poc/zerogpu-space'); \
            import vocal_pitch, json; print(json.dumps(vocal_pitch.readiness(), indent=2))"
npx vitest run tests/unit/live-pipeline.test.ts  # 84 checks on the planner side
```
