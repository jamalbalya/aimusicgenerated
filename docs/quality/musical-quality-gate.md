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

### An instrumental is a song with no singer

A score with nothing sung reaches the gate two ways, and they are not the same
thing. `score.lyrics` tells them apart.

| The score | What it means | Verdict |
| --- | --- | --- |
| No lyrics, nothing sung | Written without a voice, because that is what was asked for | Judged on everything that is not the voice |
| Lyrics, nothing sung | The singing is missing and cannot be judged | `ANALYSIS_UNAVAILABLE` |

The gate exists to ask whether the singing fits the chords. For an instrumental
that question has no subject, which is not the same as having no answer —
refusing to deliver an instrumental for having no vocal would be the gate
failing a song for meeting its brief.

This is not a bypass. Every per-note measurement would read zero for a song with
no notes, `harmonicCompatibility` included, so running the melody checks
unchanged would fail a song for the absence of the thing it was ordered without.
What can still be wrong about an instrumental is its speed, so the tempo check
still runs and an instrumental at the wrong tempo is still
`REGENERATION_REQUIRED`. The report carries `measurements: null` and states in
its own `limitations` that no vocal was judged, rather than implying one was and
passed.

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

- **10 attempts offline** (`OFFLINE_MAX_ATTEMPTS`), **5 for a neural engine**
  (`DEFAULT_MAX_ATTEMPTS`). Offline takes cost local CPU time and nothing else,
  so spending ten is cheap and it matters: at the measured pass rate, five
  attempts leave about one run in six delivering nothing, which is a broken
  product even though it is a safe one. A neural take spends a share of a free
  GPU allowance that resets on someone else's schedule, so five is the limit
  there.
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

## One press, one render, one song

The gate used to run on a finished take, so a song that did not fit its own
chords cost a render to discover and another to replace. That is the wrong place
for it.

A score is not audio. It is a list of notes and the chords underneath them, so
whether the melody fits can be decided **before a single sample exists** — and a
note that does not fit can be moved. `repairMelody` (`src/engine/compose/repair.ts`)
runs as the last step of `composeSong`:

- Only notes a listener lands on are moved. Passing tones, neighbour notes and
  suspensions that resolve are how melodies are written; flattening them would
  turn every line into an arpeggio.
- A note moves to the **nearest** pitch the chord contains, preferring the
  direction the line was already going. Jumping it to the root would fix the
  harmony and destroy the tune.
- **Everything but pitch survives**: the beat the note starts on, how long it is
  held, its velocity, the syllable it sings, the phonemes that syllable resolved
  to, and the lyric line it belongs to. The words still land on the beats they
  were written for.
- Escalation exists for one case the gentle pass cannot fix: a melody transposed
  wholesale keeps every interval, so each wrong note still reads as a passing
  tone of the note beside it. When the song is still failing after the gentle
  passes, weak notes and out-of-key strong notes move too.

**Moving a note is composition. Rolling the dice again is regeneration.** This
does the first.

### Measured

| | Before repair | After repair |
| --- | --- | --- |
| Generated songs clearing the gate | 57 / 90 | **90 / 90** |
| Notes moved | — | **2.4%** |
| One-pass rate, 25 genres × 8 seeds × 3 tempo conditions | — | **600 / 600 (100%)** |

A deliberately wrecked plan — every sung note pushed a semitone off — repairs
from `REGENERATION_REQUIRED` (compatibility 0.639, 13 severe conflicts) to
`PASS` (0.968, none), with the lyrics still on their original beats.

So the Studio does **one render**. The gate still runs on the score that was
rendered, as a check that the plan was sound rather than a filter choosing
between rolls. When it fails, nothing is opened and the studio says so.

### What this does not do for the neural engine

Nothing. ACE-Step is a stochastic text-to-music model whose endpoint takes six
inputs — style, lyrics, language, vocal gender, instrumental, duration — and
none of them is a tempo, a key, a chord, a melody or an arrangement. There is no
plan to repair, because there is no plan: the song is produced whole and the
first time anyone can inspect it is after the GPU has been spent.

A one-pass guarantee for the neural path is therefore **not available**, and
claiming otherwise would be a claim about a control surface that does not exist.
What is available there is the generate → analyse → reject loop, which is a
different thing and is documented as one.

## Tempo

### What ACE-Step can and cannot be told

**ACE-Step has no tempo parameter.** Its endpoint takes a style string, a lyric
sheet, a language, a vocal gender, an instrumental flag and a duration. A
caption reading "72 BPM" is text the model may or may not act on, and on one
real song it did not: the request was 72 and the result was 89.8 BPM, held to
0.3 BPM across ten thirty-second windows. Steady, confident, and wrong.

So tempo is **not enforced at generation time for the neural engine, and cannot
be**. It is enforced at delivery time, which is the only kind of enforcement
available here.

The **offline engine is different**: it composes at the tempo it is given, so
`score.bpm` *is* the tempo and the check against it is exact rather than
estimated.

### The requirement

`TempoRequirement` (Python: `requirements.py`, TypeScript: `src/engine/quality/tempo.ts`)

| Field | Default |
| --- | --- |
| `target_bpm` / `targetBpm` | — |
| `tolerance_bpm` / `toleranceBpm` | **2.0 BPM** |

Validated before anything is generated: positive, inside 40–220 BPM, with a
positive tolerance. Nothing is rounded into range — a tempo nobody can play is a
request to fix, not a number to adjust behind someone's back.

Two BPM is 2.8% at 72: inside what a rhythm section drifts by, far outside what
a generated track does. A tolerance loose enough to absorb 89.8 against 72 would
be a formality, not a tolerance.

**No tempo requested is not a tempo that passed.** `not_requested` is its own
reason and says so.

### Detection

`tempo.detect_tempo` measures the pulse from the **autocorrelation of the onset
envelope, with the peak interpolated parabolically**, then disambiguates the
octave with a log-normal prior at 120 BPM, 0.9 octaves wide.

This is not a preference. librosa's beat tracker reports from a fixed grid of
candidate tempos and returns **117.45 for a 120 BPM click track and 143.55 for a
140 one** — about 2.5 BPM out each, which against a 2 BPM tolerance would fail
songs that were exactly right, and every failure would have been blamed on the
model. Interpolated autocorrelation lands within **0.62 BPM across all eleven
calibration tempos** (60, 66, 72, 80, 90, 100, 110, 120, 128, 140, 160).

The prior width is the loosest that works: 1.1 octaves sends 140 BPM to 69.9.

### What the tempo check reports

| Reason | Meaning |
| --- | --- |
| `ok` | Inside tolerance |
| `not_requested` | Nothing was asked for, nothing checked |
| `tempo_mismatch` | Outside tolerance → `REGENERATION_REQUIRED` |
| `half_time` / `double_time` | Measured at half or twice the request |
| `unstable_tempo` | Windowed spread > 5 BPM → no single tempo exists |
| `low_confidence` | Estimate below 0.25 confident |
| `detection_failed` | No pulse found at all |

**Octave errors are named, never silently accepted.** A song measured at 144
against a requested 72 is either correctly written and miscounted, or genuinely
twice as fast, and nothing in the audio says which. `accept_octave_errors` is
off by default and says so in the report when a policy turns it on.

`unstable_tempo`, `low_confidence` and `detection_failed` produce
`ANALYSIS_UNAVAILABLE`, not `REGENERATION_REQUIRED` — a tempo that could not be
measured has not failed, and sending someone to regenerate would be sending them
to fix a broken analysis.

### Time-stretching: deliberately not used

**Strategy A (regenerate) is what is implemented.** `timeStretchAudio` exists in
`src/engine/audio/pitchshift.ts`, but it is browser DSP and the analysis lives
in Python, and — more to the point — stretching a finished mix by 24% to drag
89.8 BPM onto 72 would put phase-vocoder artefacts through a vocal the gate then
has to judge. A take at the wrong tempo is regenerated, never corrected.

## The live-generation switch

A build only calls the Space when it has been told it may:

```
ACE_STEP_LIVE_GENERATION_ENABLED=true
```

Off unless set to an explicit `true`, `1`, `yes` or `on`. An unset variable, a
typo and a deliberate `false` all mean off, because each is a case where nobody
decided to spend the allowance. With it off the provider refuses **before the
request is planned and before a byte reaches the network** — no request, not a
request that failed — and says so in words that cannot be mistaken for a backend
that is down, since the remedies are nothing alike.

| Build | Switch | Why |
| --- | --- | --- |
| Deployed site (`deploy.yml`) | **on** | The normal workflow: open the site, sign in, generate |
| CI end-to-end (`ci.yml`) | **on** | Points at a fake Space the suite answers itself; nothing reaches Hugging Face |
| Local checkout, `npm run dev` | **off** | Running this repo cannot spend a GPU allowance by accident |

## One pipeline, two callers

`gate.py` used to contain its own copy of the analysis, and the copy drifted. On
a real 309-second ballad it reported **z = +2.30** where `analyze.py` reported
**+0.72** on the same audio — and the permissive one was `gate.py`, the file
that decides whether a song reaches a listener.

The cause was frame selection. Running the same measurement at three
strictnesses settles it:

| Frames counted | Sung | z | weakest-4 | clashes >2 s |
| --- | --- | --- | --- | --- |
| Every voiced frame | 149.2 s | +2.30 | 31.8% | 9 |
| + formant filter | 76.7 s | **+0.72** | 37.1% | 5 |
| + stricter filter | 45.1 s | +0.43 | 39.3% | 3 |

Monotonic, in the direction that settles it: the more certainly the frames were
voice, the worse the fit. The permissive figure was leaked saxophone correlating
with itself.

**There is now one implementation.** `pipeline.evaluate_audio(path, requirements,
thresholds)` does the whole thing; `gate.py` is 37 lines with no analysis left in
it, and `analyze.py` calls the same function for its verdict. A test asserts
that neither file reimplements `librosa`, `pyin`, `compatibility(` or `formant`.

### Verdict precedence

Explicit and ordered, because which check wins is a product decision:

1. audio unreadable → `ANALYSIS_UNAVAILABLE`
2. separation unreliable → `ANALYSIS_UNAVAILABLE`
3. vocal analysis unreliable → `ANALYSIS_UNAVAILABLE`
4. tempo unmeasurable → `ANALYSIS_UNAVAILABLE`
5. tempo outside tolerance → `REGENERATION_REQUIRED`
6. harmony fails → `REGENERATION_REQUIRED`
7. severe conflicts → `REGENERATION_REQUIRED`
8. pitch fails → `REGENERATION_REQUIRED`
9. everything required passed → `PASS`
10. otherwise → `REVIEW_REQUIRED`

Unavailable outranks failure on purpose, and nothing outranks unavailable into a
pass.

Every report carries `accepted`, `delivery_allowed` and `rejection_reasons`.
The controller requires **both** the policy verdict **and** `deliveryAllowed`,
so a report whose own fields forbid delivery cannot get through on the strength
of its label.

## Vocal frames: which ones are actually a voice

A separator hands back a "vocal" stem and a pitch tracker calls anything in it
voiced. Neither is a claim about singing, and the thing Spleeter most often puts
on the wrong side is a **saxophone** — pitched, continuous, vibrato-carrying, in
exactly a male singer's register, and named in this project's own style prompts.

`voice.analyse_frames` scores each frame on:

- **formant energy** at 1.5–4 kHz, where the third formant and consonants live;
- **consonant evidence** above 5 kHz, contextually — a held vowel has no
  fricative in it and is still singing, so what matters is that consonants
  happen *nearby*;
- **range plausibility** — 70–1200 Hz;
- **accompaniment dominance** — a frame whose spectrum looks like the other stem
  is probably the other stem.

Reported per track: `total_vocal_presence_seconds`,
`usable_vocal_analysis_seconds`, `vocal_analysis_coverage_ratio`,
`probable_instrumental_contamination_seconds`, and the discarded time by reason.

**Coverage is a gate of its own.** Below 35% of the vocal's own active time, or
below 20 usable seconds, the verdict is `ANALYSIS_UNAVAILABLE` — throwing away
most of a song and passing it on what remains is its own failure.

## Jazz tensions

`pipeline.weigh_clashes` weighs rather than counts. A ninth, eleventh or
thirteenth is the sound of the genre this project generates, and a passing or
approach tone lasting a fraction of a beat is a line moving.

A clash is **severe** only when it lasts longer than **two seconds** *and*
longer than **one beat at the measured tempo**. The beat term matters: a beat at
72 BPM is nearly twice a beat at 140, and the ear counts beats.

Nothing here was loosened to let a particular song through. A jazz line that
parks on the band's weakest pitch classes for over two seconds and more than a
beat is not being subtle.

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
| Offline runs delivering a song within 10 attempts | — | **23 / 24** |
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

## The live ACE-Step path is a different pipeline

Everything above describes the **offline procedural engine**, where the gate
runs on a composed score before a sample exists and a note that does not fit
can be moved. That is possible because the engine's own working is visible.

The **live ACE-Step path** cannot work that way and does not pretend to. It is
documented separately in [`live-ace-step-pipeline.md`](./live-ace-step-pipeline.md).
The short version: one press of Generate mints one request ticket, the ticket is
spent before a socket opens, and there is no second request under any
circumstance — not a retry, not a candidate, not a regeneration after a failed
check. Everything that can be decided or refused locally happens first, while it
is still free; what comes back is measured once and reported, never re-rolled.

The two paths never substitute for each other. A neural request that fails,
fails.
