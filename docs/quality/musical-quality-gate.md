# The musical quality gate

## The problem it exists for

A vocal can be accurate to five cents and still be wrong.

Analysis of a real generated song found a vocal with a grid median of 5.5 cents,
no register worse than 5.4, drift essentially zero, and 95.6% of its notes
inside the detected key — and a harmonic compatibility z of **−2.49**, meaning
the melody scored *worse than chance* against the accompaniment. Right key,
right tuning, wrong notes.

That failure is invisible to every measure of tuning, and it is invisible to
"what percentage of the melody is in the key". G major contains both C and B;
over an Am chord one of them is the third and the other is a semitone of grit
held under the singer's own line, and no count of pitch classes can tell them
apart.

So the gate's unit of judgement is not a note. It is a **note and the chord
sounding underneath it at that moment**.

## Verdicts

| Verdict | Meaning | What happens |
| --- | --- | --- |
| `PASS` | Every mandatory check met, on evidence strong enough to act on | Delivered |
| `REGENERATION_REQUIRED` | A hard failure | Never delivered; another take is generated |
| `ANALYSIS_UNAVAILABLE` | The evidence cannot support a judgement | Never delivered as verified; regeneration is not attempted, because it would not help |
| `REVIEW_REQUIRED` | Inside every threshold, but genuinely ambiguous | Not delivered automatically; offered, clearly marked |

Two rules are absolute and are covered by tests:

- **`ANALYSIS_UNAVAILABLE` never becomes `PASS`.** Not when the numbers look
  perfect, not when confidence is high. A measurement that cannot be attributed
  to the voice cannot clear the voice.
- **A `REGENERATION_REQUIRED` take is never returned, offered, or kept as a
  fallback.** When the attempts run out, nothing is delivered. Falling back to
  the last failure would deliver exactly the songs the gate was built to catch,
  while appearing to have checked them.

## What is judged, per note

Each sung note is placed against the harmonic region active at its start, and
then the gate tries hard to *excuse* it. Most non-chord tones are how melodies
are written, and a gate that failed them would fail all music.

| Relation | Meaning | Weight |
| --- | --- | --- |
| `chord-tone` | In the chord | 1.0 |
| `tension` | A colour the chord accepts — a 9th, a 6th, a 4th | 0.9 |
| `passing` | Stepping through, between two notes, in one direction | 0.8 |
| `neighbour` | Leaves by step and returns to where it came from | 0.8 |
| `resolved` | Dissonant, then steps into a chord tone soon enough | 0.8 |
| `chromatic` | Outside the key, unexplained | 0.2 |
| `conflict` | Against the chord, unexplained, audible | 0.0 |

`harmonicCompatibility` is the duration-weighted mean of those weights: the
share of sung time that the harmony explains.

### The interval table

Read from the chord's actual pitch classes, not a quality name.

| Interval above root | Verdict | Why |
| --- | --- | --- |
| b9 (1) | conflict | A semitone beating against a sounding root |
| 9 (2) | tension | A colour on anything |
| m3 (3) | conflict over a major chord | The opposite third is the loudest wrong note in music |
| M3 (4) | conflict over a minor chord | Same, the other way |
| P4 (5) | **tension** | See below |
| b5/#11 (6) | conflict | Unless the chord has it |
| 5 (7) | tension | A chord voiced without one |
| b13 (8) | conflict over a major chord | The same semitone clash as the minor third |
| 13 (9) | tension | |
| b7 (10) | tension | |
| M7 (11) | conflict over a dominant | Both sevenths at once |

**The perfect fourth is the interval theory itself is split on.** Jazz calls it
the avoid note over a major chord because it sits a semitone above the third.
Modal and rock writing use it constantly, and for a reason that is not taste:
over any chord that is not the tonic, the fourth above the root is frequently
the key's own tonic held as a pedal. A gate that fails a song for singing the
tonic is wrong. So it is a colour, and duration and resolution decide whether a
particular one is a suspension or a mistake.

### What makes a note count

A note is **strong** — one the ear lands on rather than passes through — when it
lasts at least `strongNoteBeats`, or is accented past `accentVelocity`, or falls
on a downbeat or the middle of the bar.

A conflict is **severe** when it is strong, unexplained, and held past **both**
`maxUnresolvedDissonanceBeats` and `maxUnresolvedDissonanceSeconds`. Both,
because each catches what the other misses: seconds is what the ear measures,
beats is what stops a very slow song excusing a clash that lasts a whole bar.

## Thresholds

All in `src/engine/quality/thresholds.ts`, all configurable, all covered by
tests. Strict defaults:

| Threshold | Default | Why there |
| --- | --- | --- |
| `maxStrongOutOfKeyPercent` | 5 | Not zero: one borrowed leading tone is writing, not a defect |
| `maxStrongChordConflictPercent` | 8 | An in-key note can still be wrong over a chord; a little is normal |
| `maxUnresolvedDissonanceBeats` | 1 | A suspension resolves within the bar or it is not one |
| `maxUnresolvedDissonanceSeconds` | 0.7 | What one beat meant at the mid tempo the beat figure was chosen for |
| `maxSevereConflicts` | 0 | There is no reading of one that is not a wrong note |
| `minHarmonicCompatibility` | 0.80 | A melody written to the progression scores well above; one written against it cannot reach it by chance |
| `minConfidenceForPass` | 0.70 | Below this, PASS would be labelling an unverified song verified |
| `maxRangeViolations` | 0 | A note the voice cannot reach is not a take |
| `maxSeriousPitchDeviationPercent` | 5 | Audio evidence only; skipped, not passed, on a symbolic score |
| `seriousPitchDeviationCents` | 35 | |
| `maxTimingProblemPercent` | 25 | Loose: sung phrasing is not quantised |
| `timingToleranceBeats` | 0.125 | |
| `strongNoteBeats` | 0.5 | Shorter than this and the ear hears the line, not the note |
| `accentVelocity` | 0.75 | |
| `resolutionBeats` | 1 | |
| `intentionalChromaticRepeats` | 2 | Once is an accident; twice in the same place in the bar is a decision |

### Deliberate chromaticism

A chromatic pitch class recurring at the same metrical position reads as writing
rather than a slip. Those notes are **not** counted as failures, but a take that
leans on them returns `REVIEW_REQUIRED` rather than `PASS` — this gate cannot
tell a blue note from a wrong one, and says so instead of guessing.

## Regeneration

`src/engine/quality/controller.ts`, and the same loop inline in the Studio's
offline path.

- Default **5 attempts** (`DEFAULT_MAX_ATTEMPTS`).
- A **fresh seed for every attempt**, never repeated within a run. A seed the
  user typed is honoured for attempt 1 only; the rest draw fresh ones, and the
  attempt log says so.
- **Style and lyrics are snapshotted on entry and compared on every attempt.**
  A regeneration loop must never become a rewriting loop. Indonesian text,
  section tags and all, reaches every attempt byte for byte.
- Every attempt is logged and every rejected attempt keeps its report.
- `ANALYSIS_UNAVAILABLE` stops the loop immediately rather than spending five
  jobs on a free GPU to arrive at the same sentence: the reason analysis failed
  is a property of the machine, not of the take.

```
Attempt 1 → REGENERATION_REQUIRED → reject
Attempt 2 → REGENERATION_REQUIRED → reject
Attempt 3 → PASS → deliver
```

All attempts failing:

```
Generation failed the musical quality gate after 5 attempts.
No incorrect audio was delivered.
```

## Correction order

1. Regenerate the complete song.
2. Regenerate with improved musical conditioning, where the engine has any.
3. Regenerate with key/scale/chord constraints, where the engine supports them.
4. Reject the result when reliable conditioning is unavailable.

**Never** pitch-shift the finished mix to hide a harmonic problem, and never
move the instrumental to make a wrong vocal note fit. Pitch correction moves a
note to the nearest grid position, and in the failure this gate exists for every
note is already there — that is what makes it invisible to a tuning meter. The
repair is a different melody, not a retuned one.

## What ACE-Step actually supports

Checked against `poc/zerogpu-space/app.py`, `src/engine/providers/aceStepRequest.ts`
and the live Space's own `/gradio_api/info` contract.

| Control | Supported? | Detail |
| --- | --- | --- |
| Explicit key | **No** | No parameter exists |
| Explicit scale | **No** | No parameter exists |
| Chord progression conditioning | **No** | No parameter exists |
| Melody conditioning | **No** | `task_type` is `text2music`; no melody input |
| Vocal melody reference | **No** | No reference-audio input on this deployment |
| MIDI conditioning | **No** | No parameter exists |
| Vocal range conditioning | **No** | Only free text in the caption |
| Seed | **Partly** | `GenerationParams` accepts `seed`/`use_random_seed`, and the local backend sets them. The ZeroGPU Space hardcodes `GenerationConfig(use_random_seed=True)` and its endpoint declares only six inputs — style, lyrics, language, vocal_gender, instrumental, duration — so a seed cannot be sent. The seed it drew comes back in the result metadata. |
| Guidance / inference steps | **Partly** | Fields exist on `AceStepTaskBody` for the local backend; the ZeroGPU endpoint does not take them |

So steps 2 and 3 of the correction order are **not available on the free
deployment**. Every hint the studio offers — including the vocal preset chips —
travels as free text in the caption and describes a performance; it does not
make the model sing a particular note. Nothing here claims otherwise.

That leaves step 1, which is what the generate → analyse → reject → regenerate
loop is. Because the Space draws a fresh random seed on every request, each
attempt is genuinely a new take without the studio having to ask for one.

## Where each engine is judged

| Engine | Evidence | Confidence | Can reach PASS? |
| --- | --- | --- | --- |
| Offline procedural | The score the engine wrote — the same notes and chords the renderer plays | 1.0 (nothing is estimated) | **Yes** |
| ACE-Step, in the browser | One mixed stereo file | — | **No** — `ANALYSIS_UNAVAILABLE` |
| ACE-Step, offline analyser | Separated stems via `poc/audio-quality/` | Estimated | **Yes** |

### Why the browser cannot judge a neural take

Judging a melody against a chord progression needs the melody on its own, and
separating a voice from a band needs a trained separator — Spleeter's 2stems
checkpoint is 73 MB on top of several hundred megabytes of TensorFlow.

The tempting shortcut is to measure the mix anyway and discount the result. That
is not a weaker answer, it is the wrong one, and this project has the
measurement to prove it: on one real song, harmonic compatibility measured from
the full mix was **z = +6.46**, which reads as a melody following the chords
closely. The same song measured on separated stems scored **z = −2.49**, worse
than chance. The mix figure was not noisy — it was inverted, because the
accompaniment leaks into the "vocal" track and then correlates with itself.

A gate that can return a confident PASS on a song that should be rejected is
worse than no gate, because it launders the failure. So the browser refuses, and
says where to get a real verdict: `poc/audio-quality/analyze.py` on the
downloaded file.

## Defects this gate found

All four were in the offline composer, all four were deterministic, and none had
been found by listening.

1. **Major-key progression templates applied in minor keys.** A genre's
   progression list is a list of idioms, not of keys, and numerals carrying an
   explicit quality keep it through transposition. `iim7 - V7 - iiim7 - vim7` in
   C minor becomes Dm7, G7, Ebm7, Abm7 — chords built on A, B, Gb, Db and Cb,
   none of them in C minor — while the melody writer went on using the scale.
   Fixed by tagging every template with the mode it is written in and filtering
   the pool by the key's mode.

2. **Inversions choosing a bass from a fixed `[3, 4, 7]` list** regardless of
   the chord's quality, so a minor chord could be given a major third
   underneath it — `G#m7/C`, a C natural a semitone below the chord's own B, in
   the most exposed voice in the mix. Fixed by taking the bass from the chord's
   own pitch classes.

3. **Roman numerals in modes they were never written for.** Case implies a
   quality and an accidental measures from the parallel major; both assumptions
   break in dorian, locrian, harmonic and melodic minor. In C dorian `bVI`
   builds on A flat while the sixth degree is A natural. Fixed by `fitChordsToMode`,
   which replaces any chord containing a note the key does not have — and leaves
   major and natural minor entirely alone, where those notes are deliberate.

4. **Gapped scales used as harmonic scales.** The minor pentatonic has five
   notes and degrees on which no triad exists at all. Fixed by harmonising from
   the parent scale, which is how this music is actually written.

Measured effect on the offline engine, 20 prompts × 10 seeds:

| | Before | After |
| --- | --- | --- |
| Takes passing the gate | 4% | **58%** |
| Prompts reaching PASS within 5 attempts | — | **18 / 20** |
| Prompts reaching PASS within 10 attempts | — | **20 / 20** |

## What the gate cannot do

- It cannot prove a song sounds good. It can prove specific things are wrong.
- On a symbolic score it judges the melody against the chords **as written**. It
  says nothing about the synthesis, the mix, or how the voice sounds.
- It cannot tell a deliberate blue note from a mistake, which is why
  `REVIEW_REQUIRED` exists.
- It has no opinion on rhythm beyond a loose grid check, and none at all on
  timbre, arrangement or lyrics.
- On the audio path it inherits every limit of the separator and the pitch
  tracker, which `poc/audio-quality/README.md` states.
