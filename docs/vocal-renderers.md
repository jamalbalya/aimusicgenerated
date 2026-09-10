# Swapping the singer

The composition engine decides what is sung. A **vocal renderer** decides how it
sounds. They meet at one interface, and nothing on the composition side knows
which renderer is in use.

```
Style + Lyrics
      ↓
Composition engine            src/engine/compose/*
      ↓  Score
Vocal performance             src/engine/voice/performance.ts
      ↓  VocalPerformance
Vocal renderer                src/engine/voice/renderer.ts     ← the seam
      ↓  VocalStems (lead / response / harmony)
Mixer                         src/engine/synth/render.ts
      ↓
Master → export               src/engine/synth/render.ts
```

`src/engine/synth/pipeline.ts` runs that chain end to end.

## The contract

```ts
interface VocalRenderer {
  readonly id: string
  readonly label: string
  readonly quality: 'procedural' | 'neural' | 'external'
  readonly description: string
  isAvailable(): boolean | Promise<boolean>
  render(performance: VocalPerformance, options: VocalRenderOptions): Promise<VocalStems>
}
```

A renderer is handed everything it needs and owns nothing else. It does not
write lyrics, choose chords, decide the structure or generate a melody — all of
that is settled before it is called.

### What it receives

`VocalPerformance` (`src/engine/voice/performance.ts`) — the language, the voice
asked for, and every phrase in the song. Each phrase carries its section, its
role (`lead` / `response` / `harmony`), the line exactly as written, and its
notes. Each note carries:

| Field | Meaning |
| --- | --- |
| `startSeconds`, `durationSeconds` | absolute timing, already resolved from beats |
| `midi` | pitch, fractional allowed |
| `syllable` | the written syllable and its phonemes; `null` continues the previous one |
| `velocity`, `emphasis` | how loud, and how much it is leaned on |
| `articulation` | `attack` / `legato` / `melisma` |
| `vibrato` | depth in cents, rate in Hz, onset in seconds |
| `slide` | semitones the pitch scoops up from |
| `breathAfter` | seconds of room at a line ending |

### What it returns

`VocalStems` — one mono `Float32Array` per role, at the requested sample rate
and length. The mixer applies gain, EQ, panning and sends, so a renderer should
return a clean, unprocessed voice.

## Adding one

1. Implement `VocalRenderer`.
2. Call `registerVocalRenderer(new YourRenderer())` from a module the app imports.
3. Pass `vocalRendererId: 'your-id'` to `renderSong`.

`isAvailable()` is what makes this safe: a renderer whose model has not been
downloaded, or whose service has no key, returns `false` and the local singer is
used instead. Asking for nothing always gets the local singer, so a build never
changes its output because of which modules it happened to pull in.

## The local singer

`ProceduralVocalRenderer` (`src/engine/voice/procedural.ts`) is a source-filter
formant model: a glottal pulse shaped by four resonances tuned to each vowel.

It runs offline, costs nothing, is deterministic, and pronounces every supported
language. **It sounds like a synthesiser, not a person**, and no amount of
tuning changes that — it models the vocal tract, while a listener recognises a
human voice from vocal-fold irregularity, glottal noise, coarticulation and
per-phoneme micro-timing that the model does not represent at all.

It is the fallback, and it should always be described as synthesised singing.
