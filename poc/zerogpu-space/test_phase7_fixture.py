"""The Phase 7 fixtures are the right song, and the payload carries them intact.

One real generation will be spent on these two files. If the wrong lyric
fixture is wired up, that mistake is not recoverable by re-running: the quota
is gone and the song is of some other words. This suite exists to make that
mistake impossible to make quietly.

It checks three separate things, because any one of them alone has a way of
passing while the product is wrong:

  1. **The files are the right ones.** Content, not filename. A fixture swapped
     for another song, truncated, or rewritten fails here even if the path in
     the workflow never changed.
  2. **The workflow points at them.** A correct fixture nothing reads is not a
     correct run.
  3. **The compiled payload still carries them.** The engine compiles Style and
     Lyrics before they reach ACE-Step, and a compiler that drops a verse, sings
     the `[End]` marker or forgets the tempo would pass 1 and 2 and still spend
     the generation on the wrong thing.

No network. The compiler runs locally through Node, which is the same code path
the real run takes.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
FIXTURES = HERE / "fixtures"
STYLE = FIXTURES / "tetap-memilihmu-style.txt"
LYRICS = FIXTURES / "tetap-memilihmu-lyrics.txt"
WORKFLOW = REPO / ".github" / "workflows" / "real-run.yml"

#: The lyric sheet as the owner supplied it, pinned by content.
#:
#: A hash is a tripwire, not a specification: it says "this changed", never
#: "this is right". So the named checks below carry the meaning and this one
#: only catches an edit that slipped past all of them. If the owner supplies a
#: revised sheet, the new digest goes here in the same commit as the new file —
#: never the other way round, and never by pasting whatever the failure printed.
LYRICS_SHA256 = "b652eb567013a1af9a34ede2b7be14f75421dd73a4ef8ca1f8266714a2c01994"

#: The requested tempo. It lives in the Style prose, which is where the planner
#: reads it from, so this is the number that must survive into the payload.
REQUESTED_BPM = 72

#: What reaches ACE-Step's text field on the forensic run.
#:
#: `bare` means the caption is the person's Style byte for byte. The planner
#: still derives its directions and `MusicControlSpec` is untouched — they are
#: simply not appended, so that the generation answers one question: does the
#: model follow the Style, the bpm field, the lyrics and the melody, or does it
#: follow the planner's paraphrase? A caption reading "Pop" makes a song that
#: comes back Pop unfalsifiable.
CAPTION_MODE = "bare"

#: Lines that identify this sheet and no other. The title line is the hook and
#: appears in both choruses; the opening image appears once.
SIGNATURE_LINES = [
    "Aku tetap memilihmu",
    "Malam menaruh cahaya di jendela",
    "Aku ingin menua di sampingmu perlahan",
    "Dan aku tetap memilihmu",
]

#: Sheets that must never be mistaken for this one. `real-run-lyrics.txt` is a
#: different Indonesian song that was the workflow's default until Tetap
#: Memilihmu's own lyrics were supplied, and it is the swap this suite exists to
#: catch: same language, same shape, same section tags, wrong song.
FOREIGN_LINES = [
    "Kembalilah padaku malam ini",
    "Bawa pulang semua yang hilang",
    "Seperti dulu, seperti dulu",
    "Kopi dingin di atas meja",
]

#: The planner's derived vocabulary. None of it may reach the caption in bare
#: mode unless the person happened to write the same word themselves.
DERIVED_TAGS = [
    "popular", "muted and measured", "straight", "steady time",
    "sung lead vocal", "baritone", "warm lower-mid range",
    "verse-chorus structure", "synth bass", "saw lead", "warm pad",
    "no robotic delivery", "major-key lift",
]

PASSED = 0
FAILED: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED
    if condition:
        PASSED += 1
        print(f"  ok   {name}" + (f"  ({detail})" if detail else ""))
    else:
        FAILED.append(name)
        print(f"  FAIL {name}" + (f"  ({detail})" if detail else ""))


def main() -> int:
    print("=== 1: the fixtures on disk are the Tetap Memilihmu sheet ===")
    check("the lyric fixture exists", LYRICS.exists(), str(LYRICS))
    check("the style fixture exists", STYLE.exists(), str(STYLE))
    if not (LYRICS.exists() and STYLE.exists()):
        print("\nthe fixtures are missing; nothing below can be proven")
        return 2

    raw = LYRICS.read_bytes()
    text = raw.decode("utf-8")
    style_text = STYLE.read_text(encoding="utf-8")

    for line in SIGNATURE_LINES:
        check(f"it contains {line!r}", line in text)
    for line in FOREIGN_LINES:
        check(f"it is NOT the other song: {line!r} absent", line not in text)

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    markers = [line for line in lines if line.startswith("[")]
    sung = [line for line in lines if not line.startswith("[")]
    check("it has 10 section markers", len(markers) == 10, str(len(markers)))
    check("it has 50 sung lines", len(sung) == 50, str(len(sung)))
    check("the last marker is [End]", markers[-1] == "[End]", markers[-1])
    check("[End] is the last line of the sheet", lines[-1] == "[End]", lines[-1])
    check("nothing follows [End]",
          text.rstrip().endswith("[End]"), repr(text.rstrip()[-20:]))
    check("no carriage returns, which would change every line",
          b"\r" not in raw)

    digest = hashlib.sha256(raw).hexdigest()
    check("the sheet is byte-for-byte what was supplied", digest == LYRICS_SHA256,
          f"{digest}"
          + ("" if digest == LYRICS_SHA256
             else " — if the owner supplied a revised sheet, update "
                  "LYRICS_SHA256 in the same commit; otherwise this is an edit "
                  "to someone else's words and should be reverted"))

    check(f"the style asks for {REQUESTED_BPM} BPM",
          re.search(rf"\b{REQUESTED_BPM}\s*BPM\b", style_text, re.I) is not None,
          style_text.strip()[:60] + "...")
    check("the style is the pop ballad, not the earlier jazz one",
          "pop ballad" in style_text.lower() and "jazz" not in style_text.lower())

    print("\n=== 2: the workflow sends these fixtures and no others ===")
    workflow = WORKFLOW.read_text(encoding="utf-8")
    check("the workflow defaults to the Tetap Memilihmu lyrics",
          "fixtures/tetap-memilihmu-lyrics.txt" in workflow)
    check("the workflow defaults to the Tetap Memilihmu style",
          "fixtures/tetap-memilihmu-style.txt" in workflow)
    check("the other song is not the default any more",
          'default: "poc/zerogpu-space/fixtures/real-run-lyrics.txt"' not in workflow)
    check("the run step passes the lyrics through",
          "--lyrics-file" in workflow)
    check("the run step passes the style through",
          "--style-file" in workflow)
    check("the run step passes the caption mode through",
          "--caption-mode" in workflow)
    check(f"and the forensic run defaults to {CAPTION_MODE!r}",
          f'default: "{CAPTION_MODE}"' in workflow)
    check("and it still cannot start itself",
          "workflow_dispatch:" in workflow
          and not re.search(r"^\s*(push|schedule|workflow_run):", workflow, re.M))

    print("\n=== 3: the compiled payload still carries them ===")
    # The engine's own compiler, the same one the real run invokes. If Node is
    # not here this cannot be proven, and an unprovable check reports
    # UNVERIFIED rather than passing.
    command = [
        "node", str(REPO / "scripts" / "build-melody.mjs"),
        "--style-file", str(STYLE),
        "--lyrics-file", str(LYRICS),
        "--vocal-gender", "male",
        "--language", "auto",
        "--duration", "210",
        # The forensic run's mode. Checking `compiled` here would prove the
        # wrong thing: what matters is what the one real generation sends.
        "--caption-mode", CAPTION_MODE,
    ]
    try:
        finished = subprocess.run(command, cwd=REPO, capture_output=True,
                                  text=True, timeout=600)
    except FileNotFoundError:
        print("  UNVERIFIED  Node is not available, so the payload was not compiled.")
        print("              This is not a pass. Sections 1 and 2 hold; section 3")
        print("              is unproven and Phase 7 must not run on this result.")
        FAILED.append("the payload could not be compiled (Node missing)")
        finished = None
    if finished is not None:
        check("the compiler accepts the fixtures", finished.returncode == 0,
              finished.stderr[-300:] if finished.returncode else "")
        if finished.returncode == 0:
            built = json.loads(finished.stdout)
            request = built["request"]
            check("the planner accepts the request", built["valid"] is True)
            # The gate the builder actually applies is `usable`, and an
            # error-severity problem is what clears it. Warnings are reported
            # and do not block — asserting "no problems at all" would be a
            # stricter rule than the product's own, which is a different thing
            # from the product being right.
            problems = built["melody"].get("problems") or []
            errors = [p for p in problems if p.get("severity") == "error"]
            warnings = [p for p in problems if p.get("severity") != "error"]
            check("the melody has no error-severity problem",
                  not errors, "; ".join(f"{p['code']}: {p['message']}" for p in errors))
            check("so a target melody is actually sent",
                  built["melody"].get("usable") is True
                  and bool(built["request"]["melody"]),
                  f"usable={built['melody'].get('usable')}, "
                  f"{len(built['request']['melody'])} chars")
            for problem in warnings:
                print(f"       note: {problem['code']} — {problem['message']}")

            sent_lyrics = request["lyrics"]
            missing = [line for line in sung if line not in sent_lyrics]
            check("every sung line reaches the payload verbatim",
                  not missing, f"{len(missing)} missing: {missing[:3]}")
            kept_markers = [m for m in markers if m != "[End]"]
            missing_markers = [m for m in kept_markers if m not in sent_lyrics]
            check("every section marker reaches the payload verbatim",
                  not missing_markers, str(missing_markers))
            for line in FOREIGN_LINES:
                check(f"the other song's {line!r} is not in the payload",
                      line not in sent_lyrics)

            # The terminator is a marker, not words. Singing "End" at the close
            # of the song is the exact defect it exists to prevent.
            check("[End] is consumed as a terminator and never sent",
                  "[End]" not in sent_lyrics)
            check("no line of the payload is a bare end tag",
                  not any(line.strip().lower() in ("[end]", "(end)")
                          for line in sent_lyrics.splitlines()))
            check("the payload ends on the last written lyric, not on a marker",
                  [line for line in sent_lyrics.splitlines() if line.strip()][-1]
                  == "Dan aku tetap memilihmu",
                  [line for line in sent_lyrics.splitlines() if line.strip()][-1])

            # The whole point of the forensic mode, stated as an identity
            # rather than a containment: not "the Style is in there somewhere"
            # but "the caption IS the Style". Containment passed happily while
            # 116 characters of derived tags rode along behind it.
            check("sent_caption === original_user_style",
                  request["style"] == style_text.strip(),
                  f"{len(request['style'])} chars sent, "
                  f"{len(style_text.strip())} authored")
            check("  ... and not one character more",
                  len(request["style"]) == len(style_text.strip()),
                  f"{len(request['style'])} against {len(style_text.strip())}")
            check("the caption mode is recorded, not assumed",
                  built["plan"].get("captionMode") == CAPTION_MODE,
                  str(built["plan"].get("captionMode")))
            # None of the planner's derived vocabulary may appear unless the
            # person wrote that word themselves.
            derived_only = [tag for tag in DERIVED_TAGS
                            if tag.lower() not in style_text.lower()]
            leaked = [tag for tag in derived_only
                      if tag.lower() in request["style"].lower()]
            check("no derived semantic tag was appended to the caption",
                  not leaked, str(leaked))
            # And the planner must still have derived them. A bare caption that
            # came from a planner deriving nothing would pass every check above
            # and mean something entirely different.
            withheld = built["plan"].get("captionWithheld") or []
            check("the planner still derived its directions, and they are "
                  "recorded as withheld rather than silently absent",
                  len(withheld) > 0, f"{len(withheld)} withheld")
            print(f"       withheld from the caption ({len(withheld)}):")
            for item in withheld:
                print(f"         - {item['text']}")

            check(f"bpm reaches the payload as the integer {REQUESTED_BPM}",
                  request["bpm"] == REQUESTED_BPM
                  and isinstance(request["bpm"], int)
                  and not isinstance(request["bpm"], bool),
                  f"{request['bpm']!r}")
            check("and the planner read it from the style rather than guessing",
                  built["plan"].get("bpmStated") is True,
                  str(built["plan"].get("bpmStated")))
            check("duration reaches the payload", request.get("duration") == 210,
                  str(request.get("duration")))
            check("the sheet is recognised as Indonesian",
                  request.get("language") == "id", str(request.get("language")))
            check("it is not sent as an instrumental",
                  request.get("instrumental") is False,
                  str(request.get("instrumental")))

            # The eleven fields in the order app.py binds them, built exactly as
            # real_run.py builds them. What the Space receives is this list.
            payload = [
                request["style"], request["lyrics"], request["language"],
                request["vocalGender"], request["instrumental"],
                int(request["duration"]), int(request["bpm"]),
                request["keyscale"], "4", -1, request["melody"],
            ]
            check("the provider payload has the eleven fields app.py binds",
                  len(payload) == 11, str(len(payload)))
            check("  field 1 is the style", payload[0] == request["style"])
            check("  field 2 is the lyrics", payload[1] == request["lyrics"])
            check("  field 6 is the duration", payload[5] == 210, str(payload[5]))
            check(f"  field 7 is bpm {REQUESTED_BPM}", payload[6] == REQUESTED_BPM,
                  str(payload[6]))
            check("  field 11 is the target melody",
                  bool(payload[10]) and payload[10] == request["melody"])
            check("no field of the payload carries the other song",
                  not any(line in json.dumps(payload) for line in FOREIGN_LINES))

    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    if FAILED:
        for name in FAILED:
            print(f"  - {name}")
        print("\nDO NOT RUN PHASE 7. The fixtures or the payload are not what "
              "the owner asked for, and the generation is not repeatable.")
        return 1
    print("\nThe Phase 7 fixtures are the Tetap Memilihmu Style and Lyrics, the")
    print("workflow sends them, and the compiled payload carries them intact at")
    print(f"{REQUESTED_BPM} BPM. Phase 7 is not triggered by this script.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
