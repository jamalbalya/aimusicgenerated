# Verifying the live Hugging Face Space by hand

Nothing in this repository can reach `huggingface.co` or `*.hf.space`. The build
environment's proxy refuses both:

```
huggingface.co:443                        -> connect_rejected:
  gateway answered 403 to CONNECT (policy denial or upstream failure)
jamalbalya-resonant-acestep.hf.space:443  -> connect_rejected: (same)
```

So every check below has to be run by a person on a machine that can reach it.
Until they are, the Space side of this project is **unverified** — not broken,
not working, unknown.

Record the result of each check as PASS, FAIL or BLOCKED with the evidence
beside it. "It seemed fine" is not a result.

## Before you start

Open the browser's developer tools on the Network tab and leave them open. Most
of these checks are answered by what crosses the wire, not by what the page
says.

---

## 1. The Space is up

Open the Space's own host, not its `huggingface.co` page:
`https://<owner>-<space>.hf.space`

- [ ] The Gradio interface renders.
- [ ] `https://<owner>-<space>.hf.space/gradio_api/info` returns JSON naming
      `generate_music` with **six** parameters: `style`, `lyrics`, `language`,
      `vocal_gender`, `instrumental`, `duration`.

If it lists more or fewer than six, the studio and the Space disagree about the
contract and nothing below is meaningful until that is resolved.

## 2. The lyric-counting patch is actually deployed

This is the one that matters most, and it is invisible from the outside. Open
the Space's **Files** tab on huggingface.co and read the source:

- [ ] `guard.py` contains `SECTION_TAG_ONLY` and `def count_lyric_lines`.
- [ ] `app.py` contains `lyric_lines_sent = guard.count_lyric_lines(lyrics)`
      and **not** the old `line.strip().startswith("[") and ...` expression.
- [ ] The Space's commit history shows that change committed and the Space
      rebuilt after it (status **Running**, not **Building**).

Until all three are ticked, treat the patch as **not deployed**, whatever the
repository says. The repository is not the Space.

## 3. A short prompt, no lyrics

In the studio on GitHub Pages, Neural mode, Instrumental **on**:

- Style: `slow cinematic piano, minor key`
- Length: Auto

- [ ] Network shows `POST .../queue/join` returning an `event_id`.
- [ ] `GET .../queue/data` opens and stays open (status `200`, type
      `text/event-stream`).
- [ ] The page moves through *Waiting for the neural music engine* →
      *Generating song*.
- [ ] A WAV comes back and the player loads it.
- [ ] It plays, and it is not silence.
- [ ] **Export** in the player writes a file to disk. Open it in something else
      (QuickTime, VLC, a DAW) and confirm it is the same length and not silent —
      a download that only *starts* proves nothing.
- [ ] The result panel shows the model name, the language model, and a seed.

This is the cheapest real proof that the whole path works. Run it first.

## 4. Prompt plus lyrics

Same, Instrumental **off**, a short sheet with two section tags:

```
[Verse 1]
Aku masih di sini menunggu
[Chorus]
Sampai malam berganti pagi
```

- [ ] Generation completes.
- [ ] A voice is audible singing those words.
- [ ] Export as MP3 and as WAV. Both open elsewhere and both carry the vocal.
- [ ] No `The Space received N lyric lines; M were sent.` error. If you see one,
      check 2 again — that is exactly the failure the patch fixes.

## 5. Lyrics over the limit are refused before the queue

Paste a lyric sheet longer than 4096 characters:

- [ ] The studio refuses immediately, naming the overshoot.
- [ ] **No `queue/join` request appears in the Network tab.** This is the whole
      point: a refusal that still costs GPU time is not a refusal.

Repeat with a style over 512 characters. Same expectation.

## 6. A style just under the limit still works

- [ ] A style of roughly 500 characters generates normally, so the check is not
      refusing things it should accept.

## 7. Vocal gender reaches the caption

Generate twice with the same style, once Male and once Female:

- [ ] The two voices differ.
- [ ] If your style already contains the word "male" or "female", check the
      request payload: the studio should not have appended a second hint.

## 8. Errors from the Space are shown, not swallowed

Easiest with the allowance: generate until ZeroGPU refuses.

- [ ] The studio shows the Space's own words, including the wait time.
- [ ] The quota banner fills in with the figure from that refusal.
- [ ] The Generate button returns to normal rather than staying stuck.

Also worth forcing once: sign out mid-generation, or let the Space sleep, and
confirm the failure is reported rather than leaving a spinner.

## 9. Seed

- [ ] Generate the same brief twice. The two songs differ.
- [ ] The seeds shown differ.
- [ ] The result panel says `drawn by ACE-Step · cannot be reused`, and the Seed
      input is disabled.

If the two songs are ever identical, something has changed on the Space and the
documentation in `docs/architecture/neural-generation.md` needs revisiting.

---

## Recording the outcome

Copy this line per check into your report:

```
3. short prompt, no lyrics — PASS — 41 s, 138 s WAV, plays, exports, seed 1043872291
5. over-limit lyrics       — PASS — refused in <100 ms, no queue/join in Network
2. patch deployed          — FAIL — app.py still has the old startswith test
```

A check nobody ran is BLOCKED, not PASS.
