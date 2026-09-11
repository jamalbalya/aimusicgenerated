# Evaluation checklist — first real ACE-Step run

**Nothing here is scored yet.** No ACE-Step audio exists at the time of
writing, and no box below may be ticked from a successful API call, a valid WAV
header, or a clean run of the smoke test. Every line is a listening judgement.

Fill this in once `evaluation/bos-toxic/<run>/audio.wav` exists.

---

## The run

Copy from `metadata.json` beside the audio. These are facts, not judgements.

| | |
|---|---|
| ACE-Step version / commit | |
| DiT model | |
| LM model | |
| Backend / device | |
| Task id | |
| Generation time | |
| Output duration | |
| Sample rate / channels | |
| Peak | |

Did the models that ran match the models requested? The smoke test refuses to
continue if not, so a completed run means yes.

---

## 1. Vocal realism

| | Yes / No / Partly | Notes |
|---|---|---|
| Sounds like a person rather than a synthesiser | | |
| Audible breath between phrases | | |
| Vibrato present, and natural rather than uniform | | |
| Smooth transitions between notes | | |
| Phrasing follows the meaning of the line | | |
| Consistent voice throughout | | |

## 2. Indonesian

| | Yes / No / Partly | Notes |
|---|---|---|
| Pronunciation recognisably Indonesian, not English-accented | | |
| Syllable count matches the written lines | | |
| Intelligible to an Indonesian speaker | | |
| Words with /u/ and /o/ distinguishable | | |

## 3. Lyric fidelity

| | Count / Notes |
|---|---|
| Lines sung, of 68 written | |
| Words missing | |
| Words substituted | |
| Unintended repetitions | |
| Section order as written | |

## 4. Music

| | Yes / No / Partly | Notes |
|---|---|---|
| Melody has shape and a memorable chorus | | |
| Harmony coherent and in one key | | |
| Arrangement changes between sections | | |
| Dynamics: chorus lifts, verses sit back | | |

## 5. Dangdut koplo authenticity

| | Yes / No / Partly | Notes |
|---|---|---|
| Kendang present and recognisable | | |
| Koplo groove, not generic pop | | |
| Bass line moves the way koplo bass does | | |
| Guitar idiomatic | | |
| Call-and-response in the break | | |
| Chorus has the energy the style calls for | | |
| Intro and outro belong to the song | | |

## 6. Mix

| | Yes / No / Partly | Notes |
|---|---|---|
| Vocal clear and in front | | |
| Vocal / instrument balance | | |
| No clipping | | |
| No harshness | | |
| Low end controlled | | |
| Stereo image sensible | | |

---

## 7. Level

Tick exactly one, with evidence from the sections above.

| | |
|---|---|
| **LEVEL 0** — nothing usable came out | |
| **LEVEL 1** — functional: a recognisable song with recognisable words, obviously synthetic | |
| **LEVEL 2** — listenable: a person would sit through it once | |
| **LEVEL 3** — convincing: same perceived quality class as the TopMediai reference | |
| **LEVEL 4** — indistinguishable from a professional production | |

**LEVEL 3 is a comparison, not a milestone.** It means a listener would put this
in the same bracket as the TopMediai reference. It is not earned by:

- the API call succeeding
- a valid WAV
- a technically clean WAV
- vocals being present
- the smoke test exiting zero

Only listening establishes it.

Evidence for the level chosen:

> _(write here)_

---

## 8. Comparison against TopMediai

Same style, same lyrics, both played on the same speakers or headphones, at
matched loudness. Score each 1–5, where 3 means "about the same".

| | TopMediai | Resonant / ACE-Step | Notes |
|---|---|---|---|
| 1. Vocal realism | | | |
| 2. Vocal clarity | | | |
| 3. Indonesian pronunciation | | | |
| 4. Lyric adherence | | | |
| 5. Melody | | | |
| 6. Arrangement | | | |
| 7. Dangdut koplo authenticity | | | |
| 8. Dynamics | | | |
| 9. Mix | | | |
| 10. Overall perceived quality | | | |

**Verdict:**

> _(same quality class / below it / above it — and why)_

---

## 9. What to do next

| If | Then |
|---|---|
| Vocals absent or instrumental | Check `llm_initialized` in the log — `thinking` needs the LM loaded |
| Lyrics wrong or missing | Compare `lyric_lines_sent` in the metadata against what was sung |
| Wrong language | Check `vocal_language` was `id` |
| Quality below LEVEL 3 but the path works | Now, and only now, the A/B across turbo/sft and 0.6B/1.7B is worth running |
| Generation too slow to iterate | Fewer inference steps before changing models |

The model comparison (turbo vs sft, 0.6B vs 1.7B) is deliberately **not** part
of this first run. One successful real generation first.
