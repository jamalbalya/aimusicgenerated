# Quality evaluation — "Bos Toxic"

A measured assessment of what this project actually produces, using the
Indonesian dangdut koplo test song as the subject. Every number below comes
from a measurement over the rendered audio, and the harness that produced them
is described at the end so it can be re-run.

## Before anything else: what could not be tested

The quality gate this document answers asked for a comparison across
`acestep-v15-turbo` and `acestep-v15-sft`, across language-model sizes of 0.6B,
1.7B and 4B, and a parameter search over diffusion steps, CFG scale,
temperature and seed.

**None of that can be run, because there is no neural model in this project.**

```
$ grep -ril "acestep\|onnx\|torch\|transformers\|diffusers\|huggingface\|safetensors\|webgpu" src/ package.json
(no matches)

$ node -e "console.log(require('./package.json').dependencies)"
{ '@breezystack/lamejs': '^1.2.7', react: '^19.3.0',
  'react-dom': '^19.3.0', zustand: '^5.0.15' }

$ grep -rn "registerVocalRenderer" src/
src/engine/voice/renderer.ts:60:export function registerVocalRenderer(...)
src/engine/voice/procedural.ts:137:registerVocalRenderer(new ProceduralVocalRenderer())
```

What exists is the *seam* for one: a `VocalRenderer` interface, a
renderer-independent `VocalPerformance` data model, and a selection function
that falls back to the local singer when a preferred renderer is unavailable.
The only renderer registered against that seam is the procedural one. There are
no model weights, no inference runtime, and no network calls anywhere in the
project.

Reporting turbo-versus-sft comparisons or a CFG sweep would therefore mean
inventing numbers. The rest of this document grades the thing that does exist.

## What was measured

One render of the test song: style `Indonesian dangdut koplo, sarcastic
workplace anthem, powerful kendang, groovy bass, funky guitar, dramatic male
vocal, explosive sing-along chorus`, with the full 68-line lyric, at 44.1 kHz
with stems kept.

| | |
|---|---|
| Title chosen | Bos Toxic |
| Language detected | Indonesian |
| Genre matched | koplo |
| Tempo | 110 BPM |
| Length | 160.6 s |
| Voice | male, baritone |
| Renderer | procedural (formant synthesis) |

## Results

### Lyric fidelity — PASS

| Measure | Value |
|---|---|
| Written lines (excluding section tags) | 68 |
| Phrases actually sung | 68 |
| Written syllables | 680 |
| Syllables actually sung | 680 |
| Lead / call-and-response phrases | 64 / 4 |

Every written line is sung, once, in order, with no line dropped and none
repeated to fill a bar. The four question-and-answer lines in the
`[Instrumental Break]` are detected and given to a response voice rather than
the lead.

### Structure — PASS

The twelve sections named in the lyric sheet all survive into the arrangement,
in order, with their intensities assigned by kind:

```
Intro 0.28 · Verse 1 0.50 · Pre-Chorus 0.66 · Chorus 0.92 · Verse 2 0.50
Pre-Chorus 0.66 · Chorus 0.92 · Bridge 0.55 · Instrumental Break 0.34
Final Chorus 1.00 · Outro 0.30 · End 0.30
```

The final chorus is the loudest section and the intro the quietest, which is
what the sheet asks for.

### Vocal presence — PASS

| Measure | Value |
|---|---|
| Validation verdict | `vocal-song`, no problems |
| Vocal share of the 800 Hz – 5 kHz band | 0.824 |
| Vocal energy above 800 Hz | 0.587 of its own spectrum |
| Peak | 0.93 |
| Integrated level | −12.5 dB |

The vocal owns the band words are heard in. This was the defect behind the
earlier "no vocal sings the song" report and it is measurably fixed.

### Pitch accuracy — PASS

Estimated from the rendered vocal stem by autocorrelation and compared against
the pitch the performance asked for, over 70 sustained notes:

| Measure | Value |
|---|---|
| Median error | 3.8 cents |
| 90th percentile error | 11.1 cents |
| Notes within 50 cents | 100% |

The singer is in tune. It is, if anything, *more* in tune than a person.

### Arrangement dynamics — PASS

5.2 dB between the quietest and loudest section, ramped rather than stepped,
applied before bus compression so the compressor does not flatten it back out.

### Vowel intelligibility — PARTIAL

This is the measure that decides whether a listener hears words or hears a
vowel-coloured hum. For each vowel, the share of its own energy that lands in
the band around its own second formant — the formant that says *which* vowel
this is — compared against what every other vowel puts in that same band:

| Vowel | F2 | Owns its own band | Margin over the nearest rival |
|---|---|---|---|
| /a/ | 1196 Hz | yes | 5.5× |
| /i/ | 2070 Hz | yes | 2.3× |
| /u/ | 626 Hz | yes | 1.5× |
| /o/ | 948 Hz | yes | 1.4× |
| /e/ | 1748 Hz | **no — loses to /i/** | 0.6× |

Four of the five vowels of the language are shaped distinctly enough to be told
apart. /e/ is not: /i/ puts more energy into /e/'s own formant band than /e/
does, so the two are liable to be heard as the same vowel. Whole-spectrum
correlation between vowel pairs runs 0.77 to 0.96, which is high — these are
recognisable vowels, not confusable-at-random ones, but they are not crisply
separated the way a recorded voice's are.

Consonants are articulated as stops, fricatives, nasals, liquids and trills
with their own noise bands and burst timing, but they are short and quiet
relative to the vowels, and no measurement here establishes that a listener
could transcribe an unfamiliar line.

### Naturalness — FAIL

| Measure | Value | What a voice measures |
|---|---|---|
| Valley depth between harmonics | 14.9 – 29.1 dB | roughly 15 – 25 dB |
| Two takes of the same syllable, waveform correlation | 0.46 | low, as here |

The source is now aperiodic enough to sit at the edge of the natural range for
the front vowels and still too clean for the back ones. More to the point, the
things this metric cannot see are the ones that matter most: there is no
consonant coarticulation, no vocal fry, no register break, no phrase-level
breath control, and no timbral change between a shouted chorus and a muttered
verse beyond a gain and a formant tilt. The result is recognisably a synthetic
voice and would be identified as one by any listener, immediately.

This is not a tuning problem. It is what source-filter formant synthesis
sounds like.

### Genre authenticity — PARTIAL

The koplo arrangement has the kendang pattern on low and mid toms, rim
backbeat, tambourine and conga, the andalusian progression, and the
organ/bass/flute/strings/guitar instrument set. What it does not have is the
*gedug* interplay and the cengkok ornamentation that make the genre
recognisable to someone who listens to it, and the instruments are synthesised
rather than sampled, so the timbres are approximations.

## Level

Restating the scale this was to be graded against:

| Level | |
|---|---|
| 0 | Nothing usable comes out |
| 1 | Functional — a recognisable song with recognisable words, obviously synthetic |
| 2 | Listenable — a person would sit through it once |
| 3 | Convincing — could pass for a real recording to a casual listener |
| 4 | Indistinguishable from a professional production |

**This project is at LEVEL 1, reaching into LEVEL 2 on the instrumental.**

The composition, arrangement, structure, timing, tuning and mix are solid — a
listener would accept the backing track. The vocal is the ceiling: it is
audible, in tune, in the right language, singing the right words at the right
moments, and it is unmistakably synthesised.

Under the gate's own rule — do not declare production-ready below LEVEL 3 —
**this is not production-ready as a vocal song generator.** It is a working,
free, offline music generator with a synthetic singer.

## What changed in this pass

Two real defects were found by measurement and fixed, and the numbers before
and after are with the same harness:

**1. The five-vowel languages had no /u/ of their own.** Indonesian, Spanish,
Italian, Tagalog, Turkish, Greek, Korean and the rest were borrowing the
English "oo" vowel, whose second formant (870 Hz) sits within 30 Hz of the
pure /o/ (900 Hz). The two vowels were not separable:

| | before | after |
|---|---|---|
| /o/ owns its own F2 band | no — loses to /u/ (0.49×) | yes (1.4×) |
| /u/–/o/ spectral correlation | 0.958 | 0.955 |
| /i/–/u/ spectral correlation | 0.825 | 0.776 |

A pure `U` vowel was added to the inventory (F1 315 Hz, F2 680 Hz) and the
five-vowel languages routed onto it. English keeps `UW`.

**2. The source was perfectly periodic.** Aspiration ran at a constant level
through a narrow band around 1200 Hz, which left 20–35 dB valleys between the
harmonics — a comb no larynx produces, and a large part of why formant
synthesis reads as an oscillator. Aspiration is now broadband and rides the
glottal opening, as turbulence at the glottis actually does, and jitter and
shimmer are drawn once per cycle rather than once per sample, which is the
quantity they physically are.

| Vowel | comb depth before | after |
|---|---|---|
| /a/ | 28.2 dB | 22.7 dB |
| /i/ | 20.5 dB | 14.9 dB |
| /u/ | 32.8 dB | 28.8 dB |
| /e/ | 29.0 dB | 23.4 dB |
| /o/ | 34.5 dB | 29.1 dB |

Neither change is a mixing trick. No output gain, compression, reverb, stereo
width, saturation or EQ was touched; both are changes to the vocal-tract and
glottal-source model, which is where an improvement has to happen for it to be
an improvement at all.

Both are locked in by tests in `tests/unit/voice.test.ts`, which fail if either
regresses.

## What LEVEL 3 would cost

The ceiling is the renderer, and no amount of tuning inside formant synthesis
crosses it. The seam exists so that a better renderer can be dropped in; what
it would take is not a matter of prompt wording or parameter search.

| Option | What it needs | Free? | Offline? |
|---|---|---|---|
| Keep the procedural singer | nothing | yes | yes |
| ONNX/WebGPU singing model in the browser | a singing-voice model exported to ONNX, 100 MB – 1 GB downloaded per visit, WebGPU on the device | yes, once hosted | yes, after the download |
| ACE-Step (or similar) on a server | Python, PyTorch, a GPU, ~3.5B parameters, a backend to run it | no — a GPU costs money to run | no |
| A hosted generation API | an account and a key | no | no |

The second row is the only one that keeps both constraints this project was
built under — completely free to use, and nothing uploaded anywhere. It is a
real option and it is a large piece of work: finding or training a
multilingual singing-voice model small enough to ship to a browser, exporting
it, and writing a `VocalRenderer` that drives it from the existing
`VocalPerformance`. The seam that would receive it is already in place and
documented in `docs/vocal-renderers.md`.

Rows three and four reach LEVEL 3 and give up "free". That trade is not a
technical decision.

## Re-running the measurements

The harness composes the song, renders it with stems, and measures:

- lyric fidelity from the performance against the written sheet
- section levels from the mix, by section boundary
- vocal band share from the stems
- pitch by autocorrelation of the vocal stem against the intended MIDI
- vowel separation by rendering each vowel of the language in isolation at a
  fixed pitch and comparing band energy against every other vowel
- comb depth by comparing harmonic peaks against the midpoints between them

The parts of it that guard against regression live in
`tests/unit/voice.test.ts` and `tests/unit/architecture.test.ts` and run with
`npm test`.
