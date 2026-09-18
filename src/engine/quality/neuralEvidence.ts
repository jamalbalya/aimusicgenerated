/**
 * Why the browser cannot judge a neural take, stated once, in full.
 *
 * ACE-Step hands back one stereo mix. Judging a melody against a chord
 * progression needs the melody on its own, and separating a voice from a band
 * needs a trained separator — Spleeter's 2stems checkpoint is 73 MB on top of
 * several hundred megabytes of TensorFlow, which is reasonable for an analysis
 * tool someone runs deliberately and absurd for a web page.
 *
 * The tempting shortcut is to measure the mix anyway and discount the result.
 * That is not a weaker answer, it is the wrong one, and this project has the
 * measurement to prove it: on one real song the harmonic-compatibility score
 * taken from the full mix was z = +6.46, which reads as a melody following the
 * chords closely. The same song measured on separated stems scored z = −2.49 —
 * worse than chance. The mix figure was not noisy, it was inverted, because the
 * accompaniment leaks into the "vocal" track and then correlates with itself.
 *
 * A gate that can return a confident PASS on a song that should be rejected is
 * worse than no gate, because it launders the failure. So this returns
 * unavailable, every time, with the reason — and the offline analyser in
 * `poc/audio-quality/`, which does have a separator, is where a neural take is
 * actually judged.
 */

import type { EvidenceResult } from './types'

export const NEURAL_ANALYSIS_UNAVAILABLE =
  'A neural take is one mixed stereo file. Judging the melody against the chords needs the '
  + 'vocal on its own, and no vocal separator runs in a browser at this size. Measuring the '
  + 'mix instead was tried and measured backwards — on a real song the mix reported strong '
  + 'agreement where the separated stems reported worse than chance — so this gate refuses '
  + 'rather than guesses. Run poc/audio-quality/analyze.py on the downloaded file for a real '
  + 'verdict.'

/** Always unavailable, and always for the reason above. */
export function evidenceFromNeuralAudio(): EvidenceResult {
  return { available: false, reason: NEURAL_ANALYSIS_UNAVAILABLE }
}
