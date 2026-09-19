# Real-run fixtures

The Style and Lyrics sent to ACE-Step, one file each, verbatim. Nothing here is
rewritten, reworded or translated: the whole point of a fixture is that the run
sends exactly what the owner wrote.

`bos-toxic-*` and `real-run-*` are earlier runs. `real/` holds a generated song
kept as a regression fixture, with its own README.

## The Phase 7 fixtures

`tetap-memilihmu-style.txt` and `tetap-memilihmu-lyrics.txt` are the Style and
Lyrics for the Tetap Memilihmu run, exactly as the owner supplied them, down to
the punctuation and the blank line between every line. Both are sent verbatim.

The `72 BPM` in the style text is what the planner reads out and what reaches
`GenerationParams.bpm`; editing that phrase changes the requested tempo.

`[End]` closes the lyric sheet. It is a terminator, not a word: the reader stops
there, the marker is not sent to ACE-Step, and nothing after it would be either.
The sheet has 10 section markers and 50 sung lines.

`test_phase7_fixture.py` holds all of this to account — the sheet's content, the
workflow pointing at it, and the compiled payload still carrying it — and pins
the sheet by SHA-256 so it cannot be swapped for another song quietly. It is the
check to run before the workflow button is ever pressed. `real-run-lyrics.txt`
is a different Indonesian song and was the default until these lyrics arrived;
that swap is the specific mistake the suite exists to catch.

If the owner supplies a revised sheet, the new digest goes into
`LYRICS_SHA256` in the same commit as the new file — never by pasting whatever
a failure printed.
