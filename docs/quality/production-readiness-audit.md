# Production readiness audit

Audited at `3dc7525` on branch `free-music-generation-tools-fy4esb`.
Working tree clean; **no code was changed for this audit.**

Classifications used exactly as briefed: `PASS`, `PARTIAL`, `FAIL`,
`UNVERIFIED`, `KNOWN LIMITATION`. Where something has only been exercised
locally it says `UNVERIFIED — production`; where checking it would cost GPU
allowance it says `UNVERIFIED — requires real ZeroGPU test`.

Nothing below is marked PASS because the code reads correctly. Every PASS names
the run or the measurement behind it.

---

## A. Executive summary

The neural path is in better shape than most of its age. The provider layer is
defensive in the way that matters — it validates before spending quota, refuses
substituted models, refuses a short or unreadable song, and maps every transport
failure onto a sentence a person can act on. 511 unit tests and 54 end-to-end
tests pass; `npm audit` reports zero vulnerabilities; the production bundle
carries no secret and contacts exactly two origins.

Two findings are worth acting on before new features, and only one of them is
code deep:

1. **A double ⌘/Ctrl+Enter starts two concurrent ZeroGPU generations.** Verified
   in a real browser: two presses, two `/queue/join` calls. The Generate button
   is correctly disabled while busy; the keyboard shortcut is not guarded at all.
   On a backend where an anonymous visitor has about two minutes of GPU per day,
   one accidental double-tap can spend the day's allowance, and it also leaves
   the first generation uncancellable.

2. **The site's own headline copy is now false for its default engine.** The
   README and the About page still say "nothing uploaded anywhere", "no daily
   quota, no queue" and "Unlimited generations, every day". Since the ZeroGPU
   integration, the neural engine is the *default* once the Space answers, and
   it sends the user's lyrics to a third party, queues, and has a daily
   allowance. The "What this is not" panel further down says so correctly, which
   makes the top of the page a contradiction rather than an omission.

Everything else is medium or below. The largest remaining technical risk is
memory: a 271-second stereo song costs about **298 MB transiently and 198 MB at
rest** per take, which is almost certainly what caused the fault fixed in
`18c7692` — and that fix means the consequence is now a clear message rather
than a lost song.

**Overall: PARTIAL — production-capable, with two fixes worth making first.**

---

## B. Production architecture assessment

```
GitHub Pages (static)  ──►  *.hf.space  ──►  ZeroGPU  ──►  ACE-Step 1.5
   React SPA                Gradio queue       free GPU      turbo + 0.6B LM
   no backend of its own    protocol                         48 kHz stereo WAV
```

Assessed as sound for what it is. Three properties carry it:

- **No server of our own**, so there is no session state, no credential store
  and no scaling story to get wrong. The frontend is a static artifact.
- **One provider boundary.** `createNeuralProvider()` in `registry.ts` is the
  only place a neural provider is constructed, and the backend is chosen by
  configuration there and nowhere else. `resolveProvider()` has, deliberately,
  no `?? procedural` at the end of it.
- **The Gradio protocol is implemented in-repo** (`gradioClient.ts`, 565 lines)
  rather than taken as a dependency. That removes a supply-chain surface and
  costs us the risk of upstream protocol drift instead — a trade I would make
  the same way, with the caveat in M4 below.

The weak joint is not the architecture, it is the **UI layer above it**: the
neural generation lives in `StudioPage` component state with no lifecycle
owner, while the procedural path has `useJob`, which aborts on re-entry and on
unmount. Findings C1 and H1 are both consequences of that asymmetry.

---

## C. Critical findings

**None.** Nothing found will corrupt a result, expose a secret, or make the
application unusable. The two findings below are ranked P0 by consequence, not
by this heading.

---

## D. High-risk findings

### D1 — ⌘/Ctrl+Enter can start two concurrent generations

**Finding:** The Generate button is `disabled={busy}` (`StudioPage.tsx:816`),
but the two `onKeyDown` handlers (`:635`, `:716`) call `generateSong()` with no
busy check. Each call creates its own `AbortController` and calls
`setNeuralController`, so the second overwrites the first.

**Severity:** HIGH

**Evidence:** Playwright, real Chromium, fake Space that holds the SSE stream
open so both jobs stay in flight:

```
two ⌘/Ctrl+Enter presses 1.2 s apart
QUEUE JOINS>>> 2                      ← two /queue/join submissions
GENERATE BUTTON DISABLED>>> true      ← the button was guarded the whole time
```

**Production impact:** three distinct consequences.
- **Quota.** Two generations are submitted. An anonymous visitor has roughly two
  minutes of ZeroGPU per day; the validated song used ~45 s of GPU. A double-tap
  plausibly spends the day's allowance on one brief.
- **Cancellation is lost.** `setNeuralController(controller)` overwrites the
  first controller, so the first generation can no longer be cancelled by the
  Cancel button — only by its own 15-minute job timeout.
- **`busy` goes false while work is still running.** Whichever generation
  finishes first runs `setNeuralController(null)` in its `finally`, re-enabling
  Generate while the other is still in flight. That is an impossible state by
  the state machine in §6 of the brief.

**Recommended action:** guard both key handlers with the same `busy` the button
uses — `if (busy) return` before `generateSong()`. Optionally give the neural
path the same re-entrancy guard `useJob.run` already has
(`controllerRef.current?.abort()`), so a deliberate second run supersedes the
first rather than racing it.

**Requires code change: YES** (two lines, plus a regression test).

### D2 — The site's headline claims are false for its default engine

**Finding:** `README.md:6,9` and `AboutPage.tsx:22–23,32,37,38` state:
"nothing uploaded anywhere", "no account, no subscription, no daily quota, no
queue", "Unlimited generations, every day", "Works offline once loaded",
"Nothing uploaded, ever".

Since the ZeroGPU integration, `resolveEngineMode(null, hasAnswered)` selects
**neural** as soon as the Space answers, so these claims describe the engine a
first-time visitor is *not* on. In neural mode the style and the full lyric
sheet are sent to Hugging Face, the request queues, and the daily allowance
applies.

**Severity:** HIGH — not technical, but the one finding here that touches user
trust and privacy expectations.

**Evidence:** the claims as quoted; `registry.ts:resolveEngineMode`; the
`ZeroGpuInputs` tuple in `zeroGpuProvider.ts:77–84`, which carries the lyrics.
The About page's own "What this is not" panel already describes the neural
engine accurately, which is what makes the top of the page a contradiction.

**Production impact:** a user who reads "Nothing uploaded, ever" and then types
personal lyrics into the default engine has been told something untrue about
where their words go.

**Recommended action:** scope the claims to the offline engine — they are all
true of it — and state the neural engine's terms in the same breath. This is a
copy change, not an architecture change; the accurate wording already exists
further down the same page and in `docs/architecture/neural-generation.md`.

**Requires code change: YES** (text in two files).

---

## E. Medium-risk findings

### E1 — No lifecycle cleanup for a neural generation

**Finding:** `StudioPage` contains no `useEffect` at all. `useJob` aborts its
controller on unmount (`useJob.ts:26–32`); the neural path has no equivalent.

**Severity:** MEDIUM

**Evidence:** `grep -n "useEffect" src/ui/pages/StudioPage.tsx` returns nothing.

**Production impact:** navigating from the Studio to another tool mid-generation
leaves the request running until the 15-minute job timeout, with the GPU
allowance spent and the result discarded. React 19 no longer warns about setting
state after unmount, so this is silent.

**Recommended action:** abort the controller in a cleanup effect, and say in the
existing cancellation copy that leaving the page does not stop the Space.

**Requires code change: YES**

### E2 — Takes 1–4 is offered in neural mode with no allowance warning

**Finding:** the Takes control (`StudioPage.tsx:979–995`) is not gated on engine
mode, unlike Vocal gender which is. In neural mode `generateNeural` loops
`takeCount` times, submitting a **separate ZeroGPU generation per take**. The
hint text talks about stems and picking a favourite; it says nothing about
allowance.

**Severity:** MEDIUM

**Evidence:** the loop at `StudioPage.tsx:312`; `MAX_TAKES = 4`
(`workers/protocol.ts:63`); no `engineMode` guard on the field.

**Production impact:** Takes = 4 on the free tier will almost always produce one
song and three quota errors. It also multiplies memory — see E3.

**Recommended action:** either cap takes at 1 for the ZeroGPU backend, or keep
the control and add the allowance to its hint. Given the free tier is roughly
one song per visitor per day, capping is the honest default.

**Requires code change: YES**

### E3 — Memory headroom on a full-length song

**Finding:** a 271-second 48 kHz stereo song costs, measured from the real run's
own figures:

| | size |
| --- | --- |
| WAV on the wire | 49.6 MB |
| ArrayBuffer from `fetch` | 49.6 MB |
| decoded `Float32Array` channels | 99.2 MB |
| `AudioBuffer` copy in the player | 99.2 MB |
| **transient peak** | **297.7 MB** |
| **steady state, one take** | **198.5 MB** |
| steady state, four takes | 496.2 MB |

**Severity:** MEDIUM

**Evidence:** arithmetic over `real-run-metadata.json` (`wav_bytes` 52,032,044,
48 kHz, 2 ch, 271 s), and the copy in `player.load` (`player.ts:100–112`).

**Production impact:** this is the most plausible trigger for the fault fixed in
`18c7692`, where `createBuffer` refused the allocation. On a phone, ~300 MB of
transient JS heap plus Web Audio allocation is a real risk. Since `18c7692` the
consequence is a clear message and a still-exportable song rather than a lost
result, which is the right failure — but the allocation still fails.

**Recommended action:** do not optimise yet. Gather the evidence the fix now
produces: when a report includes "would not open the song for playback
(NotSupportedError…)", that is this. If it recurs, the cheapest real reduction
is a mono `AudioBuffer` for playback while keeping the stereo channels for
export, roughly halving both the copy and the peak.

**Requires code change: NO** (not yet — measure first)

### E4 — `127.0.0.1:8001` ships in the production bundle

**Finding:** `DEFAULT_ACE_STEP_URL` is bundled into `StudioPage`'s chunk even in
a `zerogpu` build.

**Severity:** MEDIUM-LOW

**Evidence:** `grep -roE "127\.0\.0\.1:[0-9]+" dist/assets/*.js` →
`StudioPage-CSrO4nR3.js:127.0.0.1:8001`. **And it is never requested**: a
Playwright run against a deploy-shaped build recorded every request origin —

```
ORIGINS>>> ["http://127.0.0.1:4173", "https://jamalbalya-aimusicgenerated.hf.space"]
ENGINE>>> "Neural Engine: Not Connected"
```

The only origins are the page's own and the Space's.

**Production impact:** none observed. `AceStepProvider` is never constructed
when the backend is `zerogpu`, so the string is dead configuration rather than a
localhost dependency.

**Recommended action:** leave it. Removing it would mean splitting the two
backends across chunks for no behavioural gain.

**Requires code change: NO**

---

## F. Low-risk findings

### F1 — Empty branch in the procedural error handler

`StudioPage.tsx:431–435` catches, tests `!isCancellation(error)`, and does
nothing inside the branch (the comment explains `useJob` already reported it).
Correct behaviour, dead syntax. **Severity: LOW. Requires code change: NO.**

### F2 — Builds are not byte-reproducible

`VITE_BUILD_TIME` changes every build, so two builds of the same commit differ.
Intended — it is what makes a stale cache visible — but worth stating so nobody
later treats it as a bug. **Severity: LOW. Requires code change: NO.**

### F3 — No `engines` field in `package.json`

Node is pinned by `.nvmrc` (22) and `setup-node` in both workflows, but nothing
stops a contributor building on another major. **Severity: LOW. Requires code
change: NO.**

---

## G. Known limitations

| Limitation | Status |
| --- | --- |
| Anonymous visitors get ~2 min of ZeroGPU per day; roughly one full song | KNOWN LIMITATION |
| A page reload mid-generation loses the result; the allowance is still spent, and there is no resume | KNOWN LIMITATION |
| A sleeping Space adds a cold start of minutes before the first answer | KNOWN LIMITATION |
| The Space is a free personal ZeroGPU Space: no uptime guarantee, and it sleeps after ~2 days idle | KNOWN LIMITATION |
| ACE-Step's own range is 10–600 s; longer songs need more GPU than one free request may get | KNOWN LIMITATION |
| Cancelling stops this page waiting; it does not stop the Space, and the copy says so | KNOWN LIMITATION |

---

## H. Security findings

**Status: PASS** — every item below is a measurement, not a reading.

| Check | Result |
| --- | --- |
| HF token in the browser | **PASS** — no token exists anywhere in the frontend; the only credential is an OAuth access token the visitor obtains themselves, held in memory for one tab |
| GitHub token in the browser | **PASS** — `grep -roiE "ghp_…\|github_pat_…"` over `dist/` returns nothing |
| Secrets in the Vite build | **PASS** — two allowlists (`NEURAL_SETTINGS`, `BUILD_SETTINGS`); `build-env.test.ts` offers a full Actions environment with five token-shaped values and proves none is baked |
| Secrets in `dist` | **PASS** — no `hf_`, `ghp_`, `github_pat_`, `AKIA`, or PEM header in a deploy-shaped build |
| Sensitive env exposure | **PASS** — `buildDefines` reads `process.env`, never `loadEnv`, so a `.env` file cannot reach it |
| Endpoints called | **PASS** — exactly two origins, measured above |
| Localhost dependency in production | **PASS** — string present, never requested (E4) |
| Mixed content | **PASS** — no `"http://…` endpoint in `dist`; `mixedContentReason()` refuses an http backend from an https page before probing |
| Credentials sent | **PASS** — `fetch` defaults to `same-origin`, so no cookie reaches `hf.space`. The only `Authorization` header in the tree is in `aceStepClient.ts`, the *local* backend, unused in production |
| Workflow secrets | **PASS** — a test asserts `deploy.yml` references no `secrets.*` at all |
| `npm audit` | **PASS** — 0 vulnerabilities |

No authentication should be added. The architecture does not need it and adding
it would introduce the credential store the design currently does without.

---

## I. Performance findings

| Measure | Value | Assessment |
| --- | --- | --- |
| Total JS shipped | 972 kB raw across all chunks | PASS — route-split; the entry is 235 kB |
| Largest chunks | `index` 235 kB, `studio.worker` 193 kB, `mp3` 160 kB | PASS — the worker and the MP3 encoder load only when used |
| Generated audio download | 49.6 MB for 271 s | KNOWN LIMITATION — inherent to 48 kHz stereo WAV |
| Decoded audio | 99.2 MB | See E3 |
| Transient peak | 297.7 MB | E3 — the ranked risk |
| UI responsiveness during neural generation | PASS — generation is network-bound, not CPU-bound; the procedural path renders in a worker |
| Repeated generations | PARTIAL — `neuralTakes` is replaced per run, so steady state is one to two songs; but the old take is still held while the new one decodes |

**Ranked performance risks:** (1) E3 memory on mobile; (2) 49.6 MB download on a
slow connection with no progress readout during the download phase — the status
says "Downloading the song" but not how much of it; (3) nothing else.

---

## J. Browser compatibility findings

Stated exactly as the evidence supports.

| Browser | Status |
| --- | --- |
| Chromium desktop (1280×900) | **PASS by automated test** — full E2E suite, 54 tests |
| Chromium mobile emulation (Pixel 7) | **PASS by automated test** — same suite, both projects |
| Chrome, real device | **UNVERIFIED — production** except the one owner-run generation |
| Safari desktop | **UNVERIFIED** — never run |
| Firefox | **UNVERIFIED** — never run |
| Mobile Safari | **UNVERIFIED** — never run; the highest-risk target given E3 |
| Mobile Chrome | **UNVERIFIED** — emulation is not a device |

Playwright is configured with Chromium only. `webkitAudioContext` is handled in
`player.ts:38–41`, and the `AudioContext` is created lazily on first use for
mobile autoplay policy — both correct by inspection, neither exercised.

**The trigger that caused the `18c7692` fault remains UNVERIFIED.** It was
reproduced by forcing `createBuffer` to throw; what made the reporter's browser
throw is not known.

---

## K. Test coverage matrix

| Scenario | Automated | Real browser | Production validated | Status |
| --- | --- | --- | --- | --- |
| Successful neural generation | unit + E2E | Chromium | yes, once | **PASS — production validated** |
| Successful procedural generation | unit + E2E | Chromium | not evidenced | **PARTIAL** |
| Generation failure (Space error) | unit ×7 | no | no | **PASS — automated** |
| Quota exhausted | unit ×3 | no | no | **UNVERIFIED — requires real ZeroGPU test** |
| Timeout (queue and job) | unit ×2 | no | no | **PASS — automated** |
| Malformed Gradio response | unit ×6 | no | no | **PASS — automated** |
| Missing audio output | unit ×2 | no | no | **PASS — automated** |
| Invalid / silent / short WAV | unit | no | no | **PASS — automated** |
| Model substitution refused | unit + Space-side | no | no | **PASS — automated** |
| Playback failure keeps the song | unit ×6 + E2E | Chromium | no | **PASS — automated** |
| Download / export | E2E | Chromium | not evidenced | **PARTIAL** |
| Second generation replaces the first | — | — | no | **FAIL — not covered** |
| Cancellation | unit | no | no | **PARTIAL** |
| Space unavailable / asleep | unit + E2E | Chromium | no | **PASS — automated** |
| Concurrent generation (D1) | — | — | no | **FAIL — not covered** |
| Navigate away mid-generation (E1) | — | — | no | **FAIL — not covered** |

**Three genuine gaps.** The exact tests I would add, and no others:

1. **Concurrent submission.** E2E against the fake Space: press ⌘/Ctrl+Enter
   twice, assert exactly one `/queue/join`. (I already wrote this as a throwaway
   probe; it currently fails with 2 — it is a ready-made regression test.)
2. **Second generation replaces the first.** E2E: generate, note the transport
   title, generate again with different lyrics, assert the transport now holds
   the second song and the first take's audio is no longer referenced.
3. **Navigate away mid-generation.** E2E: start a generation, route to another
   tool, assert the in-flight request is aborted.

---

## L. Documentation gaps

| Item | Status |
| --- | --- |
| Architecture | **PASS** — `docs/architecture/neural-generation.md` is current and honest, including the comparison table and the ZeroGPU allowance |
| Neural provider | **PASS** |
| HF ZeroGPU dependency | **PASS** |
| ACE-Step version and 0.6B LM | **PASS** — named, and validated in the doc with the real run |
| Duration limitations | **PASS** — 10–600 s documented; the verified 271 s is flagged in the UI |
| Quota limitations | **PARTIAL** — correct in the architecture doc and the About page's lower panel, contradicted by the headline copy (D2) |
| Player limitations | **PARTIAL** — the `18c7692` behaviour is in the commit message and the code comments but not in any document |
| Production deployment | **PASS** — the Pages workflow is self-documenting and the environment doc is current |
| Local development | **PASS** |
| Procedural vs neural behaviour | **PASS** in `docs/`, **FAIL** in `README.md` and the About page headline (D2) |

Only D2 needs a documentation change. Nothing else should be rewritten.

---

## M. Dependency / build findings

| Item | Finding |
| --- | --- |
| Vulnerabilities | **PASS** — `npm audit`: 0 |
| `typescript` 5.9.3 → 7.0.2 | a major behind. Not a blocker; a major TS bump is its own task |
| `vite` 8.2.2 → 8.3.0 | one minor behind. Not a blocker |
| Gradio client dependency | **none** — the protocol is implemented in-repo. Lower supply-chain risk, and protocol drift is ours to catch. The Space pins `gradio==6.2.0`, and `zerogpu.test.ts` asserts the client refuses another protocol version before submitting |
| Unnecessary dependencies | none found — four runtime dependencies (`react`, `react-dom`, `zustand`, `@breezystack/lamejs`) |
| Node version | `.nvmrc` 22, both workflows on 22, no `engines` field (F3) |
| GitHub Actions | **PASS** — `checkout@v4`, `setup-node@v4`, `cache@v4`, `configure-pages@v5`, `upload-pages-artifact@v3`, `deploy-pages@v4`, all current majors |
| Lockfile | present and used (`npm ci` in both workflows) |
| Reproducibility | PARTIAL — deterministic except the build timestamp (F2) |

**No dependency is a production blocker. Nothing should be upgraded as part of
this audit.**

---

## N. Data / privacy assessment

Exactly six values are transmitted, and they are the endpoint's declared inputs
(`zeroGpuProvider.ts:77–84`, `planZeroGpuRequest`):

| Sent | Value | Note |
| --- | --- | --- |
| `style` | the style text as written | the gender hint is appended only when the Space's own substring test would otherwise miss it |
| `lyrics` | **the full lyric sheet, verbatim** | line endings normalised to LF and a trailing blank run dropped; no line or character altered. `[inst]` when instrumental |
| `language` | e.g. `id` | chosen, or detected from the lyrics |
| `vocal_gender` | `male` / `female` / `mixed` | Auto travels as `mixed` |
| `instrumental` | boolean | |
| `duration` | whole seconds | Auto resolves to the configured 271 |

**Not sent:** seed (the Space draws its own and reports it back), model names
(checked in the answer instead of requested), and anything identifying — no user
id, no session id beyond Gradio's per-request `session_hash`, no cookies
(cross-origin `fetch` defaults to `same-origin` credentials).

**No telemetry and no analytics exist in the repository**, and none should be
added. Verified: no analytics script, no beacon, no third-party origin beyond
the Space.

**The one privacy finding is D2**: the lyrics genuinely do leave the device in
neural mode, and the site's headline currently says they never do.

---

## O. UX findings

| Can the user tell…? | Status |
| --- | --- |
| Which engine is active | **PASS** — a named Segmented control, a connection dot, and the engine named on every finished song |
| That generation is in progress | **PASS** — the button becomes "Generating…", a status line shows the stage |
| That the request is queued | **PASS** — "Waiting in the Space's queue (position N)", from Gradio's own rank |
| That generation succeeded | **PASS** — result panel plus a success notification |
| Which model generated it | **PASS** — DiT and LM named in the result panel |
| Duration, language, vocal mode | **PASS** — all three in the result panel |
| Why generation failed | **PASS** — see below |

**Error message quality: PASS.** They are the strongest part of the UI. ZeroGPU's
own wording is passed through verbatim where it is better than anything we could
write ("60s requested vs. 30s left. Try again in 1:23:45."), HTML is stripped
from Space messages before display (`plain()`), and no stack trace or internal
identifier reaches the screen — `failure()` maps every transport error onto a
sentence naming the problem and, where one exists, the way out.

Two UX gaps, both already recorded as findings: the Takes control says nothing
about allowance (E2), and the download phase has no progress for a 50 MB file
(§I).

---

## P. Recommended fixes

### P0 — before further production use

1. **Guard the keyboard shortcut against re-entry** (D1). Two lines plus the
   regression test in §K.1, which already exists as a probe and currently fails.
2. **Correct the headline claims** (D2). Scope "nothing uploaded / no quota /
   unlimited" to the offline engine and state the neural engine's terms beside
   them. Copy only.

### P1 — soon

3. **Abort the neural generation on unmount** (E1), and say that leaving the
   page does not stop the Space.
4. **Cap or annotate Takes on the ZeroGPU backend** (E2).
5. **Add the two missing regression tests** (§K.2, §K.3).
6. **Document the player's degraded-playback behaviour** from `18c7692` in
   `docs/architecture/neural-generation.md` — it currently lives only in a commit
   message.

### P2 — improvement

7. Show download progress for the ~50 MB result.
8. Run the E2E suite on Firefox and WebKit projects, so §J stops being three
   UNVERIFIED rows.
9. Revisit E3 only if a real report carries the playback-failure message.

### P3 — optional

10. Add an `engines` field to `package.json` (F3).
11. Plan the TypeScript 7 and Vite 8.3 upgrades as their own task.

---

## Audit method

Read in full: `zeroGpuProvider.ts`, `gradioClient.ts` (key paths), `registry.ts`,
`config.ts`, `audioCheck.ts`, `store.ts`, `player.ts`, `Transport.tsx`,
`useJob.ts`, `AboutPage.tsx`, both workflows, and the generation paths of
`StudioPage.tsx`.

Executed: the full unit suite (511), the full E2E suite (54, 2 skipped),
typecheck, lint, `npm run build`, `npm run build:single`, `npm audit`, a
deploy-shaped build with secret and localhost scans over `dist`, a Playwright
origin census, and a Playwright concurrency probe.

**No real ZeroGPU generation was run for this audit**, and no GPU allowance was
spent. Every neural test used the in-repo fake Space.
