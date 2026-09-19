# Real-run fixtures

The Style and Lyrics sent to ACE-Step, one file each, verbatim. Nothing here is
rewritten, reworded or translated: the whole point of a fixture is that the run
sends exactly what the owner wrote.

`bos-toxic-*` and `real-run-*` are earlier runs. `real/` holds a generated song
kept as a regression fixture, with its own README.

## The Phase 7 fixtures

`tetap-memilihmu-style.txt` is the Style for the Tetap Memilihmu run, exactly as
the owner supplied it, down to the punctuation. It is sent verbatim. The `72
BPM` in it is what the planner reads out and what reaches
`GenerationParams.bpm`; editing the text changes the requested tempo.

**The Lyrics for Tetap Memilihmu have never been supplied.** The request that
described that song carried a placeholder — "use the exact lyrics supplied by
the user" — and no lyric text followed it. `real-run-lyrics.txt` is a
*different* Indonesian song and is what the run will send unless a Tetap
Memilihmu lyric file is added and passed as `--lyrics-file`.

So a run made with the default lyrics is the Tetap Memilihmu **style** and
another song's words. That is worth knowing before the one generation is spent,
and it is not something to solve by writing lyrics here: inventing them would
make the run a test of invented words, and the standing instruction is that the
Indonesian lyrics are never rewritten or translated.
