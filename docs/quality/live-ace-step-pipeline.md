# The live ACE-Step pipeline

One press of Generate. One ZeroGPU request. One song.

This document describes the live path — Style and Lyrics through a Hugging Face
ZeroGPU Space running ACE-Step 1.5 — and is careful throughout about the
difference between what the system *controls* and what it merely *asks for*.
That distinction is the whole subject. ACE-Step's endpoint takes six inputs and
none of them is a tempo, a key, a chord, a melody or a seed, so most of what a
person wants from a song is a request rather than a setting.

The offline procedural engine is a separate thing and is documented in
[`musical-quality-gate.md`](./musical-quality-gate.md). It is never substituted
for this path: a neural request that fails, fails.

## A. The execution flow

```
Style + Lyrics  (two text boxes; nothing else is required)
  │
  ├─ 1 planLiveGeneration     local, free, deterministic
  │     genre · subgenre · mood · emotion · BPM · groove · key · scale
  │     chord direction · form · duration · vocal type · vocal range
  │     instruments · arrangement density · mix direction · master direction
  │     and, for the lyric sheet: syllables, density, sections, language,
  │     duplicate blocks, stray directions, whether it fits the length
  │
  ├─ 2 validation gate        ── invalid ──▶ REFUSED. Nothing sent. No GPU.
  │
  ├─ 3 compilePrompt          the plan becomes one caption inside 512 chars,
  │                           with whatever did not fit recorded as `dropped`
  │
  ├─ 4 mintRequestTicket      one permission to send, per press
  │
  ├─ 5 ZeroGpuProvider.generate
  │     • spends the ticket BEFORE opening a socket
  │     • one GET /config, one POST /queue/join, one SSE stream, one download
  │     • checks the Space's metadata against what was sent
  │
  └─ 6 verifyLiveResult       measured once, reported, never acted on by
                              generating again
```

Source: `src/engine/live/` (`plan.ts`, `lyricPlan.ts`, `promptCompiler.ts`,
`requestGuard.ts`, `verify.ts`, `constraints.ts`), driven from
`src/ui/pages/StudioPage.tsx`, sent by
`src/engine/providers/zeroGpuProvider.ts`.

## B. The one-request guarantee

Four independent mechanisms, in the order a duplicate would meet them.

| # | Mechanism | Where | What it stops |
| - | --------- | ----- | ------------- |
| 1 | `disabled` on the button while busy | `StudioPage.tsx` | The ordinary second click |
| 2 | `inFlight` ref, set synchronously | `generateSong` | A second press inside one React flush — a held ⌘/Ctrl+Enter repeats faster than state settles |
| 3 | **Request ticket**, spent before the socket opens | `requestGuard.ts` → `zeroGpuProvider.generate` | Everything else, structurally |
| 4 | One `/queue/join` per `submit`, no retry | `gradioClient.ts` | A retry inside the transport |

Mechanism 3 is the one worth arguing for. The first two are *checks*: they work
by asking whether a flag is set, and every check of that shape fails the day
someone adds a call site that does not ask. A ticket is not a check. It holds
the single permission to send, `spend()` hands it over exactly once, and every
later call throws `RequestTicketSpentError`. The provider demands one and spends
it first, so a second request is not refused by policy — there is nothing left
to send it with.

That makes the loop that used to surround `provider.generate` *unwritable*:

```ts
const ticket = mintRequestTicket()
for (let attempt = 0; attempt < 4; attempt++) {
  await provider.generate(request, { ticket })   // second iteration throws
}
```

The ticket is spent before any other check in `generate`, including the
liveness switch and the request planner. That ordering is deliberate: were it
spent last, a request refused early would leave the ticket unspent and a second
iteration would sail through. Spending first makes "one press, one request"
hold even for requests that never leave the machine.

There is **no expiry and no renewal**. A ticket that could be reissued after a
failure would be an automatic retry wearing a different name. Generating again
is a person pressing Generate again, which mints a new ticket — the only path,
by construction.

What is *not* prevented, and should not be: the "Generate again" button on a
failure panel. That is a person choosing to spend another slice of their own
allowance, it is labelled as a new generation, and it mints a new ticket like
any other press.

## C. What runs before the GPU

Everything in this list costs nothing and happens on the visitor's own machine.

**Refusals — the request is not sent and no GPU time is used:**

- Style empty.
- Lyrics empty, in a request that asked for vocals. (An instrumental request
  with no lyrics is correct, not invalid.)
- Lyric sheet with section tags but no words under them.
- Duration outside ACE-Step's own 10–600 second range, or not a number.
- **Lyrics that cannot be sung in the time requested.** Syllables are counted
  with the syllabifier for the language the words are actually in, then checked
  against 7 syllables per second of singing time — a ceiling no singer sustains
  across a whole song. This matters more than it looks: ACE-Step does not sing
  an overlong sheet faster, it installs a token budget of `duration × 5` and the
  decoder is barred from ending before it and forced to end at it, so the words
  run out of room and the song stops mid-phrase. The refusal names the length
  that would work.
- A Style already longer than ACE-Step's 512 characters. Refused rather than
  truncated: nobody's sentence is edited to make it fit.

**Warnings — shown, and the request proceeds:**

- A bracketed line that is not a section name. ACE-Step has no control
  instructions, so `[slow down here]` is four words it may sing.
- A block that repeats the block immediately before it word for word. (A chorus
  returning later is normal form and is not flagged.)
- Lyrics that read as a different language from the one requested.
- A sheet so sparse for its length that most of the song will be instrumental.
- No section tagged as a chorus, in a sheet long enough to have one.
- One section holding more than 80% of the words.

**Decided, and written into the caption:** genre, subgenre family, mood,
emotional direction, target BPM, groove, key, scale, chord character, form,
vocal type, vocal range, instrumentation, arrangement density, mix direction,
master direction.

The plan is deterministic. The seed is FNV-1a over the whole request rather than
the clock, so the same Style and Lyrics produce the same plan and the same
caption every time — a person who presses Generate twice with the same words
sends the same *request* twice, and any difference in the two songs is the
model's own randomness rather than ours.

### The 512-character budget

The caption compiler is a budget, not a template. Directions are emitted in
priority order and each is dropped if it will not fit:

1. The user's own words, whole and first. Never truncated.
2. Genre and mood — the strongest lever on a text-conditioned model.
3. Tempo and groove — cheap in characters, most often wrong.
4. Voice: whether there is one, who sings, how.
5. Key and harmonic character.
6. Instrumentation.
7. Form and arrangement density.
8. Mix and master direction — last, because ACE-Step returns one finished mixed
   file and these words move it least.

What did not fit is listed in `dropped` and shown in the interface, so nobody
believes the model was told something it was not.

## D. What is measured afterwards

Once, on the audio that came back, in `verifyLiveResult`.

| Measurement | How |
| ----------- | --- |
| File validity, channels, sample rate | WAV header, then decode |
| Duration | The file's own header, never the Space's claim |
| Tempo estimate + confidence | Onset-envelope autocorrelation |
| Peak, RMS, LUFS | ITU-R BS.1770 K-weighting for the LUFS figure |
| Crest factor | Peak minus RMS |
| Clipping | Share of samples at full scale, and the longest consecutive run |
| Silence | Share below the floor, and the longest single silent stretch |
| Dead channel / dual mono | Per-channel scan |
| Voice-band presence | Energy in 1.5–4 kHz, per frame, against that frame's proportional share |
| Spectral balance | Band energies from an STFT: low / mid / high |

**Verdicts:**

| Verdict | Meaning |
| ------- | ------- |
| `PASS` | Nothing at all to report. Unreachable in a browser, and deliberately so — see below. |
| `PASS_WITH_LIMITATIONS` | Usable, with named caveats. The normal outcome. |
| `FAILED_VERIFICATION` | A measured technical defect: silence, a dead channel, sustained clipping, a long dropout, a song shorter than the length asked for, or a vocal request whose audio has no voice-band energy at all. |
| `ANALYSIS_UNAVAILABLE` | The audio could not be measured. |

`PASS` requires an empty `notMeasured` list, and in a browser that list is never
empty. That is the design, not a gap: a song labelled fully verified on a
partial measurement is exactly the failure this project has found in its own
code twice. The verdict says `PASS_WITH_LIMITATIONS` and the limitations are
printed.

**Post-render verification never triggers a regeneration.** There is no ticket
left and no code path that mints one. A `FAILED_VERIFICATION` song is still
handed over — withholding it would leave someone who has already spent their
allowance with nothing — and it is labelled as failed, in the panel, with the
measurement that failed it.

A tempo that came back wrong is a **note**, not a failure. ACE-Step has no tempo
input, so a BPM in the caption is prose; calling the audio defective because the
model did not follow prose would be blaming the file for the API.

## E. Guaranteed, asked for, and neither

| Requirement | Status | Evidence |
| --- | --- | --- |
| One user action → one generation | **Guaranteed** | Request ticket, spent before the socket opens; `tests/unit/live-pipeline.test.ts`, `tests/e2e/live-pipeline.spec.ts` counts `/queue/join` |
| Exactly one ZeroGPU request | **Guaranteed** | Same, plus one `/queue/join` per `submit` in `gradioClient.ts` |
| No automatic regeneration or retry | **Guaranteed** | No retry anywhere in the provider or transport; a spent ticket throws |
| No multiple candidates | **Guaranteed** | The take loop is gone; one ticket cannot serve two calls |
| No preview pass, no separate vocal/instrumental pass | **Guaranteed** | One call, one mixed file |
| Invalid request costs no GPU | **Guaranteed** | Validation precedes the network; E2E asserts zero joins |
| Style and lyrics reach the model unedited | **Guaranteed** | `verifyLyricsPreserved`; the caption compiler never truncates user words |
| Song length within ACE-Step's range | **Guaranteed** | Refused pre-flight; measured post-flight against the file's own header |
| Lyrics fit the requested duration | **Checked before the GPU** | Syllable count against a singable ceiling |
| Complete song structure | **Asked for** | Section tags travel in the sheet; form named in the caption. ACE-Step returns no section timings, so adherence cannot be verified here |
| Actual BPM | **Asked for, measured after** | No tempo input exists. A real song came back 17.8 BPM from the number in its caption |
| Key / scale | **Asked for only** | No key input exists |
| Chord progression | **Asked for only** | No chord input exists |
| Melody quality | **Asked for only** | No melody or reference-audio input exists |
| Vocal quality and intelligibility | **Asked for only** | Presence is measurable; intelligibility needs transcription, which does not run here |
| Lyric accuracy (every word sung) | **Not verifiable here** | Needs transcription and forced alignment |
| Mixing | **Asked for; described after** | One mixed file comes back, no stems and no bus controls. The numbers describe the master; they do not judge it |
| Mastering | **Asked for; described after** | Same. Loudness, crest factor and clipping are measured |
| Seed | **Not available** | The Space hardcodes `GenerationConfig(use_random_seed=True)` and declares no seed input. The seed it drew comes back afterwards |
| Commercial-service-level quality | **Not claimed** | Not measurable from one mixed file, and not something an API with six inputs can be made to guarantee |

The machine-readable version of this table is `src/engine/live/constraints.ts`,
which the tests read so the document and the code cannot drift apart.

## F. What ACE-Step cannot do, stated plainly

The ZeroGPU endpoint declares six inputs:

```
style: str, lyrics: str, language: str,
vocal_gender: "male" | "female" | "mixed", instrumental: bool, duration: int
  -> (audio file, metadata JSON)
```

There is no seventh. So:

- **Tempo is not enforceable.** Writing "112 BPM" in the caption is a
  description. The measured failure that started this work: a song requested at
  72 BPM came back at 89.8, steady to 0.3 BPM across ten windows.
- **Key, scale and chords are not enforceable.** Same channel, same status.
- **Melody is not specifiable.** No melody input, no reference audio, no MIDI.
- **Seeds are not available.** No input, and the Space hardcodes a random one.
- **Section timings are not returned.** Tags steer the model; nothing reports
  where the chorus actually landed.
- **There are no stems.** One mixed, mastered stereo file. Mixing and mastering
  cannot be adjusted, only described in advance.
- **Whether the vocal fits the chords cannot be judged in a browser.** It needs
  the voice separated from the band, and no separator that runs in a browser is
  good enough. A full-mix answer to that question is not less accurate — it is
  inverted: on one real song the mix reported +6.46 where the separated stems
  reported −2.49.

## G. What improves the odds, since enforcement is unavailable

Everything in section C. The lever a caption-driven model gives you is the
quality of the request, so the pipeline spends its effort there: a planned
caption says dangdut koplo, 112 BPM, A minor, kendang and suling, verse–chorus
form, male lead, where an unplanned one said "sad Indonesian song".

This is not a claim that the model will comply. It is the difference between
asking clearly and asking vaguely, and it is the only difference available.
