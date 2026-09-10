# Resonant Studio

A complete AI music, voice and audio studio that runs entirely in the browser.
Write a song from a description, get lyrics that scan and rhyme, sing them,
split a track into stems, change a voice, synthesise speech, and edit audio —
all of it unlimited, unwatermarked and free, with nothing uploaded anywhere.

There is no server doing the work, so there is nothing to charge for: no
account, no subscription, no daily quota, no queue. Close the tab and nothing
survives except what you chose to save on your own device.

## Tools

| Tool | What it does |
| --- | --- |
| **Song Studio** | Describe a style and get a finished track: form, harmony, drums, instruments, a sung or rapped lead and a mastered mix. Write your own lyrics and they are the ones sung, in the language you wrote them in. Ask for up to four takes and each is a different song from the same brief, not the same one mixed twice. Exports the mix, the instrumental, the vocal alone, every stem, a MIDI file and timed lyrics. |
| **Lyric Writer** | Structured lyrics with a real rhyme scheme, a syllable target per line and a repeated hook. Edit any line, then hear it sung over a backing track. |
| **Text to Speech** | Eight built-in voices with control over speed, pitch, expression and effects, reading 25 languages with each one's own sounds. Exports to a file. The system's own voices are offered for preview, sorted by which of them speak the language you typed. |
| **Stem Splitter** | Pull the vocals out of any track, or split it four ways into vocals, drums, bass and everything else. |
| **Voice Changer** | Pitch and vocal-tract size as separate controls, plus ten ready-made characters. |
| **Audio Toolkit** | Trim, fade, speed, pitch, reverb, echo, EQ, drive, compression, noise reduction, normalisation — and tempo, key and loudness measurement. |
| **Library** | Everything you saved, stored in this browser. |

## How it works

**Composition.** The prompt is matched against genre and mood vocabularies to
choose a tempo, key and harmonic language. An arranger builds a song form that
fits the requested length, harmony comes from a library of progressions
transposed into the key, and melodies are built from short motifs that are
repeated and transformed — inverted, transposed, retrograded — so a tune
develops rather than wanders. Strong beats land on chord tones. Every stage is
seeded, so the same prompt and seed always produce the same song.

**Synthesis.** Nothing is sampled. Each of the 31 instruments is a synthesis
model — subtractive, FM, additive, or a Karplus-Strong plucked string — and the
20-piece kit is oscillators and filtered noise. The mix runs a real signal
chain: per-track EQ and saturation, kick-triggered ducking, a shared reverb and
ping-pong delay, bus compression and a look-ahead limiter.

**Voice.** Words become phonemes by rule, then are sung through a source-filter
model: a glottal pulse with vibrato, jitter and breath, shaped by band-pass
filters set to the formants of each vowel and gliding between them the way a
real vocal tract does. Consonants are rendered as stops, fricatives, taps,
trills and nasal resonances in between.

**Languages.** Every language brings its own answer to the question of which
sounds a spelling stands for, so each one has its own rules rather than being
read as though it were English. Twenty-five of them, and the readers match how
each script actually works: an abugida reader for Devanagari, where a consonant
carries a vowel inside it; one mora per character for the Japanese kana; and
hangul decomposed by the arithmetic its code points are built on. The phoneme
inventory carries what those languages need and English does not — pure vowels,
front rounded vowels, nasal vowels, a trilled and a tapped r, palatal nasals
and laterals, velar fricatives and a glottal stop. The language is detected
from the words themselves and can be overridden.

**Separation.** Stems come from two classical signal-processing facts:
sustained tones form horizontal ridges in a spectrogram while transients form
vertical ones, and lead vocals sit in the centre of a stereo image. Median
filtering along each axis separates harmonic from percussive; comparing the two
channels finds what is centred. The masks are soft, which avoids the
"underwater" artefacts hard masking produces.

**Getting it out.** A finished song can leave as an MP3 or WAV at several
depths, as the instrumental or the vocal on their own, as every instrument
separately, as a standard MIDI file of the whole arrangement, or as lyrics
timed against the mix in SRT for video and LRC for music players.

### What it is not

This is not a large neural model. Those need a data centre full of GPUs, which
is precisely the cost paid services are passing on. What you get instead is a
composition and synthesis engine that is genuinely unlimited and genuinely
private, with the trade-off that it sounds like a very good software instrument
rather than a recording of a band. The singer in particular is formant
synthesis: in tune, in the right language, singing the words that were written,
and audibly synthesised. `docs/quality/bos-toxic-evaluation.md` measures exactly
how far that is from a recording and says what closing the gap would cost. Separation is likewise signal processing
rather than a trained model, so heavily doubled or hard-panned vocals will not
come out as cleanly as they would from a model trained on thousands of songs.

## Running it

```bash
npm install
npm run dev            # development server
npm run verify         # typecheck, lint, unit tests, both production builds
npm run test:e2e       # end-to-end tests (desktop and mobile viewports)
npm run build:single   # one self-contained HTML file
```

Requires Node 22 or newer.

### Deploying

The production build is a static site with no backend, so it can be hosted
anywhere.

**GitHub Pages.** Pages has to be switched on once by a repository admin —
**Settings → Pages → Build and deployment → Source: GitHub Actions**. A
workflow cannot do this for you: enabling Pages needs admin rights that
`GITHUB_TOKEN` is never granted. Once it is on, every push to `main` publishes
automatically via `.github/workflows/deploy.yml`, and the site appears at
`https://<owner>.github.io/<repo>/`.

For any other host, set `VITE_BASE` to the path the site is served from — `/`
for a domain root, `/repo-name/` for a subdirectory:

```bash
VITE_BASE=/ npx vite build
```

The build writes `dist/404.html` alongside `dist/index.html` so deep links keep
working on static hosts without rewrite rules.

**A single file.** `npm run build:single` produces
`dist-single/resonant-studio.html`: the whole studio — engine, worker, styles
and all — in one 800 KB document with no external requests. Host it anywhere,
email it, or open it straight from disk. Opened from a file there is no origin
a worker can load from, so jobs run on the main thread instead; everything
still works, the interface just cannot repaint while a render is in progress.

## Architecture

```
src/
  engine/          Everything musical and audio, with no DOM dependencies
    core/          Seeded RNG and unit conversions
    theory/        Scales, chords, voice leading, progressions
    compose/       Prompt parsing, genres, arrangement, harmony, melody, drums
    synth/         DSP primitives, instruments, drum kit, effects, renderer
    voice/         Phoneme inventory, formants, singing, speech
    lang/          Letter-to-sound rules and syllables, one table per language
    lyrics/        Syllables, rhyme, inflection, vocabulary, the writer
    export/        MIDI and timed-lyric files
    audio/         FFT, STFT, separation, pitch shifting, analysis, WAV, MP3
  workers/         The worker protocol and its typed client
  ui/              Components and pages
  lib/             Player, file handling, IndexedDB library, router
  state/           Global store
tests/
  unit/            Engine tests (Vitest, runs in Node)
  e2e/             Browser tests (Playwright, desktop and mobile)
docs/
  vocal-renderers.md          The seam a different singer plugs into
  quality/                    Measured assessments of what comes out
```

The engine has no browser dependencies at all — it is plain TypeScript over
`Float32Array` — which is why it can be unit-tested in Node, run inside a
worker, and produce byte-identical output for a given seed.

## Licence

MIT. Audio you generate is yours, with no conditions attached.
