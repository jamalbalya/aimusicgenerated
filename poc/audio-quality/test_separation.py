"""The separator and the harmony measure, including every way they refuse.

Most of these are about refusal. A tool that measures a mix and calls the answer
a verdict is worse than one that has no answer, because the wrong answer gets
acted on — so what is pinned here is that the unavailable path stays unavailable,
that a bad split is caught, and that a contaminated measurement can never reach
PASS however good its numbers look.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import harmony as hm  # noqa: E402
import intonation as it  # noqa: E402
import separate_vocals as sv  # noqa: E402

SR = 44100
FAILURES: list = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {name}")
    else:
        FAILURES.append(f"{name}{': ' + detail if detail else ''}")
        print(f"  FAIL {name}{': ' + detail if detail else ''}")


print("the separator says what is missing, rather than guessing")
empty = Path("/tmp/definitely-no-checkpoint-here")
state = sv.availability(empty)
check("an absent checkpoint is not ready", not state.ready)
check("and the reason names the files or TensorFlow",
      "checkpoint" in state.reason.lower() or "tensorflow" in state.reason.lower(),
      state.reason)
check("and points at the README", "README" in state.reason)

try:
    sv.separate(np.zeros((SR, 2), dtype="float32"), SR, model_dir=empty)
    check("separating without a checkpoint raises", False, "it returned instead")
except sv.SeparatorUnavailable as error:
    check("separating without a checkpoint raises SeparatorUnavailable", True)
    check("and the message explains what to install", "README" in str(error))
except Exception as error:  # noqa: BLE001
    check("separating without a checkpoint raises SeparatorUnavailable", False,
          f"raised {type(error).__name__}")

real = sv.availability()
print(f"  ..   this machine: ready={real.ready} ({real.reason[:60]}...)")

if real.ready:
    try:
        sv.separate(np.zeros((10, 2), dtype="float32"), SR)
        check("audio too short to separate is refused", False, "it returned")
    except sv.SeparatorUnavailable:
        check("audio too short to separate is refused", True)
    try:
        sv.separate(np.zeros((SR, 5), dtype="float32"), SR)
        check("audio that is not stereo is refused", False, "it returned")
    except sv.SeparatorUnavailable:
        check("audio that is not stereo is refused", True)
else:
    check("audio too short to separate is refused", True, "skipped: no checkpoint")
    check("audio that is not stereo is refused", True, "skipped: no checkpoint")

print("\na split that did not work is caught before anything is measured")
silence = np.zeros(SR * 20, dtype="float32")
quiet, ok, why = sv.separation_quality(silence, silence, SR)
check("a silent vocal stem is not accepted as a good split", not ok, why)

loud_everywhere = (0.2 * np.sin(np.arange(SR * 20) * 0.01)).astype("float32")
quiet, ok, why = sv.separation_quality(loud_everywhere, loud_everywhere, SR)
check("a stem loud from end to end is rejected: it is the mix, not a voice",
      not ok, f"{quiet:.1f}% silent")
check("and the reason says the analysis should report ANALYSIS_UNAVAILABLE",
      "ANALYSIS_UNAVAILABLE" in why)

# A voice stops between phrases; a band does not. Two seconds on, two off.
phrases = np.concatenate([
    np.concatenate([
        (0.2 * np.sin(np.arange(SR * 2) * 0.02)).astype("float32"),
        np.zeros(SR * 2, dtype="float32"),
    ]) for _ in range(6)
])
quiet, ok, why = sv.separation_quality(phrases, phrases, SR)
check("a stem that falls silent between phrases is accepted", ok, f"{quiet:.1f}% silent")

# The defect the old gate had: it compared the opening seconds against mid-song,
# so a song that sings from the very first bar was rejected however good the
# split was. The same phrases, with the first one moved to the start.
from_bar_one = np.concatenate([
    (0.2 * np.sin(np.arange(SR * 3) * 0.02)).astype("float32"),
    phrases,
])
quiet, ok, why = sv.separation_quality(from_bar_one, from_bar_one, SR)
check("a good split is still accepted when the singing starts at bar one",
      ok, f"{quiet:.1f}% silent")

# And the hole in the other direction: a song opening on true silence made even
# a failed split look like it had worked, because the mix was quiet there too.
silent_open_then_mix = np.concatenate([
    np.zeros(SR * 4, dtype="float32"),
    (0.2 * np.sin(np.arange(SR * 20) * 0.01)).astype("float32"),
])
quiet, ok, why = sv.separation_quality(silent_open_then_mix, silent_open_then_mix, SR)
check("a failed split is not excused by a song that opens on silence",
      not ok, f"{quiet:.1f}% silent")

quiet, ok, why = sv.separation_quality(np.zeros(SR, dtype="float32"), silence, SR)
check("a clip too short to judge is not accepted", not ok, why)

print("\nharmonic compatibility, against its own null")
HOP = 512
frames = 900
times = np.arange(frames) * HOP / SR
rng = np.random.default_rng(3)


#: Middle C. Pitch class 0 in chroma numbering is C, so a band built from 220 Hz
#: would be an A triad while the test believed it was a C one — which is how the
#: first run of these tests "failed": the module was right and the fixture wrong.
C4_HZ = 261.63


def band(pitch_classes, length):
    """An accompaniment whose chroma sits on the given pitch classes."""
    signal = np.zeros(int(length), dtype="float32")
    for pc in pitch_classes:
        freq = C4_HZ * 2 ** (pc / 12.0)
        signal += 0.3 * np.sin(2 * np.pi * freq * np.arange(len(signal)) / SR).astype("float32")
    return signal


seconds = frames * HOP / SR
accompaniment = band([0, 4, 7], SR * seconds)          # a C major triad, held
sung_in = np.full(frames, C4_HZ)                        # C: a chord tone
sung_out = np.full(frames, C4_HZ * 2 ** (1 / 12))       # C#: not in the triad
voiced = np.ones(frames, dtype=bool)

fits = hm.compatibility(times, sung_in, voiced, accompaniment, SR, HOP, isolated=True)
clashes = hm.compatibility(times, sung_out, voiced, accompaniment, SR, HOP, isolated=True)
check("a chord tone scores above a non-chord tone",
      fits.mean_support > clashes.mean_support,
      f"{fits.mean_support:.3f} vs {clashes.mean_support:.3f}")
check("a chord tone is reported as strongly supported",
      fits.top3_percent > 90, f"{fits.top3_percent:.1f}%")
# Deliberately not asserting on `weakest4` here: with only three pitch classes
# sounding, the other nine are all near silent and their ordering among
# themselves is noise, while C# picks up CQT leakage from the C next to it.
# "Not among the three the band is actually playing" is the claim that means
# something on this fixture.
check("a note outside the chord is not among the band's top three",
      clashes.top3_percent < 20, f"{clashes.top3_percent:.1f}%")
check("the key is estimated from the accompaniment", fits.key is not None)
check("both report their null beside the real figure",
      fits.null_mean_support is not None and clashes.null_mean_support is not None)

print("\nthe measure refuses what it cannot support")
mixed = hm.compatibility(times, sung_in, voiced, accompaniment, SR, HOP, isolated=False)
check("a non-isolated measurement says so", not mixed.isolated)
check("and warns that leakage inflates it",
      any("leaks" in line for line in mixed.limitations))
thin = hm.compatibility(times[:20], sung_in[:20], voiced[:20], accompaniment, SR, HOP,
                        isolated=True)
check("too few frames produces no z at all", thin.z is None and not thin.sufficient)
check("and compatible is unknown rather than False", thin.compatible is None)

print("\nboth conditions must pass before a take is accepted")


def clean_intonation():
    r = it.IntonationReport(frames=900, analysed_seconds=100.0, coverage_percent=40.0,
                            track_seconds=250.0, contaminated=False)
    r.grid_median_cents = 5.0
    r.notes_drifting_over_50c = 2.0
    return r


def harmony_with(z, isolated=True, frames=900):
    r = hm.HarmonyReport(frames=frames, analysed_seconds=100.0, isolated=isolated)
    r.z = z
    r.mean_support = 0.4
    return r


status, why = it.verdict(clean_intonation(), None, harmony_with(6.0))
check("in tune and harmonically related passes", status == "PASS", f"{status} {why}")

status, why = it.verdict(clean_intonation(), None, harmony_with(0.34))
check("in tune but unrelated to the harmony asks for regeneration",
      status == "REGENERATION_REQUIRED", f"{status} {why}")
check("and says pitch correction is the wrong tool",
      any("cannot fix this" in reason for reason in why), str(why))
check("and quotes the z", any("z = +0.34" in reason for reason in why), str(why))

status, why = it.verdict(clean_intonation(), None, harmony_with(6.0, isolated=False))
check("a harmony score from a mix returns ANALYSIS_UNAVAILABLE",
      status == "ANALYSIS_UNAVAILABLE", status)
status, why = it.verdict(clean_intonation(), None, harmony_with(6.0, frames=10))
check("too little harmony data returns ANALYSIS_UNAVAILABLE",
      status == "ANALYSIS_UNAVAILABLE", status)

contaminated = clean_intonation()
contaminated.contaminated = True
status, why = it.verdict(contaminated, None, harmony_with(6.0))
check("a contaminated intonation measurement still blocks PASS",
      status == "ANALYSIS_UNAVAILABLE", status)

status, why = it.verdict(clean_intonation(), None, None)
check("with no harmony measured at all, intonation alone still passes",
      status == "PASS", f"{status} {why}")

print("\nan isolated measurement does not carry a mix's warning")
import intonation as _i
_times = np.arange(400) * 0.01
_hz = np.full(400, 220.0)
_voiced = np.ones(400, dtype=bool)
_iso = _i.measure(_times, _hz, _voiced, 10.0, isolated_vocal=True)
check("an isolated report is not marked contaminated", not _iso.contaminated)
check("and says nothing about measuring a mix",
      "mix" not in _iso.contamination_note.lower(), repr(_iso.contamination_note))
_mix = _i.measure(_times, _hz, _voiced, 10.0, isolated_vocal=False)
check("a mix report is marked contaminated and says so",
      _mix.contaminated and "mix" in _mix.contamination_note.lower())

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILED:")
    for failure in FAILURES:
        print(f"  - {failure}")
    sys.exit(1)
print("all separation and harmony tests passed")
