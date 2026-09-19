# `tetap-memilihmu.mp3`

A real ACE-Step generation. **Do not modify, re-encode or normalise it.** Its
value is that it is exactly what the model produced, and every number in
`regression_real_song.py` is measured from these bytes.

    320 kbps MP3, 48 kHz stereo, 267.024 s, peak 0.904, 0.0000% clipped

Requested style: a romantic melancholic pop ballad **at 72 BPM**, warm soulful
vocal, intimate grand piano, soft acoustic guitar, tender strings.

It came back at **98.4 BPM** — measured by three independent methods that agree
to 0.4%, with only 1.0% local drift. That is not a subdivision artefact: 72, 144
and 36 appear in no candidate set.

That is what makes it the right regression fixture. The target melody is laid
out on the *requested* tempo's grid — about 80 bars at 72 BPM, against the 110
bars the song actually has — so the plan and the performance drift apart by 27%
of elapsed time, 72 seconds by the end of the song. The correct behaviour is to
refuse to correct against that plan, and this file is the evidence that the
refusal fires on real audio rather than only on a synthetic case.

The lyrics this song was generated from were not supplied, so no target melody
can be built from them; the regression uses a plan laid out at 72 BPM over the
song's own length, which is the thing whose timeline is being tested.
