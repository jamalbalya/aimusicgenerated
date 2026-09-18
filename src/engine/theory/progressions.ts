/**
 * Chord progression library, expressed as roman numerals so a progression can
 * be transposed into any key and mode.
 */

export interface ProgressionTemplate {
  id: string
  label: string
  /** One roman numeral per bar. */
  bars: string[]
  /** Scales this progression sounds idiomatic in. */
  moods: ('bright' | 'dark' | 'wistful' | 'tense' | 'warm' | 'epic')[]
  /**
   * The mode these numerals are written in.
   *
   * This is not decoration, it is a correctness field. A numeral carrying an
   * explicit quality — `iim7`, `vim7`, `Imaj7` — keeps that quality whatever key
   * it is transposed into, because the suffix is what the writer asked for. So
   * `iim7 - V7 - iiim7 - vim7`, which is a major-key turnaround, put into C
   * minor produces Dm7, G7, Ebm7 and Abm7: four chords carrying A, B, Gb, Db and
   * Cb, none of which are in C minor. The melody writer works from the scale, so
   * it sings Eb and Bb over them, and the result is a vocal a semitone away from
   * its own accompaniment for most of the song.
   *
   * That was a real defect, found by the quality gate on 23 of 24 generated
   * songs. `either` is for progressions whose numerals stay diatonic in both
   * modes because nothing forces a quality.
   */
  mode: 'major' | 'minor' | 'either'
}

export const PROGRESSIONS: ProgressionTemplate[] = [
  { id: 'axis', label: 'I–V–vi–IV', bars: ['I', 'V', 'vi', 'IV'], moods: ['bright', 'warm'], mode: 'major' },
  { id: 'axis-rot', label: 'vi–IV–I–V', bars: ['vi', 'IV', 'I', 'V'], moods: ['wistful', 'warm'], mode: 'major' },
  { id: 'doo-wop', label: 'I–vi–IV–V', bars: ['I', 'vi', 'IV', 'V'], moods: ['bright', 'warm'], mode: 'major' },
  { id: 'canon', label: 'I–V–vi–iii–IV–I–IV–V', bars: ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'], moods: ['warm', 'epic'], mode: 'major' },
  { id: 'andalusian', label: 'i–bVII–bVI–V', bars: ['i', 'bVII', 'bVI', 'V'], moods: ['dark', 'tense'], mode: 'minor' },
  { id: 'aeolian-vamp', label: 'i–bVI–bIII–bVII', bars: ['i', 'bVI', 'bIII', 'bVII'], moods: ['dark', 'epic'], mode: 'minor' },
  { id: 'minor-pop', label: 'i–bVII–bVI–bVII', bars: ['i', 'bVII', 'bVI', 'bVII'], moods: ['dark', 'wistful'], mode: 'minor' },
  { id: 'minor-4', label: 'i–iv–bVI–V', bars: ['i', 'iv', 'bVI', 'V'], moods: ['dark', 'tense'], mode: 'minor' },
  { id: 'plagal', label: 'I–IV–I–V', bars: ['I', 'IV', 'I', 'V'], moods: ['bright'], mode: 'major' },
  { id: 'jazz-251', label: 'ii7–V7–Imaj7', bars: ['iim7', 'V7', 'Imaj7', 'Imaj7'], moods: ['warm'], mode: 'major' },
  { id: 'jazz-turn', label: 'Imaj7–vi7–ii7–V7', bars: ['Imaj7', 'vim7', 'iim7', 'V7'], moods: ['warm', 'wistful'], mode: 'major' },
  { id: 'minor-251', label: 'iim7b5–V7–i', bars: ['iim7b5', 'V7', 'i', 'i'], moods: ['dark', 'tense'], mode: 'minor' },
  { id: 'blues-12', label: '12-bar blues', bars: ['I7', 'I7', 'I7', 'I7', 'IV7', 'IV7', 'I7', 'I7', 'V7', 'IV7', 'I7', 'V7'], moods: ['warm', 'dark'], mode: 'major' },
  { id: 'trap-loop', label: 'i–bVI–bVII–i', bars: ['i', 'bVI', 'bVII', 'i'], moods: ['dark'], mode: 'minor' },
  { id: 'drill-loop', label: 'i–bIII–bVII–iv', bars: ['i', 'bIII', 'bVII', 'iv'], moods: ['dark', 'tense'], mode: 'minor' },
  { id: 'house-vamp', label: 'i–bVII–bVI–bVII', bars: ['im7', 'bVII', 'bVImaj7', 'bVII'], moods: ['dark', 'warm'], mode: 'minor' },
  { id: 'lofi', label: 'ii7–V7–iii7–vi7', bars: ['iim7', 'V7', 'iiim7', 'vim7'], moods: ['wistful', 'warm'], mode: 'major' },
  { id: 'epic', label: 'i–bVI–bIII–bVII (epic)', bars: ['i', 'bVI', 'bIII', 'bVII'], moods: ['epic', 'dark'], mode: 'minor' },
  { id: 'anthem', label: 'IV–I–V–vi', bars: ['IV', 'I', 'V', 'vi'], moods: ['epic', 'bright'], mode: 'major' },
  { id: 'folk', label: 'I–IV–vi–V', bars: ['I', 'IV', 'vi', 'V'], moods: ['warm', 'bright'], mode: 'major' },
  { id: 'country', label: 'I–IV–V–IV', bars: ['I', 'IV', 'V', 'IV'], moods: ['bright', 'warm'], mode: 'major' },
  { id: 'rnb', label: 'Imaj7–iii7–vi7–IV', bars: ['Imaj7', 'iiim7', 'vim7', 'IV'], moods: ['warm', 'wistful'], mode: 'major' },
  { id: 'gospel', label: 'I–iii–IV–iv', bars: ['I', 'iii', 'IV', 'iv'], moods: ['warm', 'epic'], mode: 'major' },
  { id: 'reggaeton', label: 'i–bVII–bVI–V', bars: ['i', 'bVII', 'bVI', 'V'], moods: ['dark', 'warm'], mode: 'minor' },
  { id: 'bossa', label: 'Imaj7–ii7–V7–Imaj7', bars: ['Imaj7', 'iim7', 'V7', 'Imaj7'], moods: ['warm'], mode: 'major' },
  { id: 'ambient', label: 'Isus2–IVsus2', bars: ['Isus2', 'Isus2', 'IVsus2', 'IVsus2'], moods: ['warm', 'wistful'], mode: 'either' },
  { id: 'metal', label: 'i–bVI–bVII–bV', bars: ['i', 'bVI', 'bVII', 'bVI'], moods: ['dark', 'tense'], mode: 'minor' },
  { id: 'punk', label: 'I–V–vi–IV fast', bars: ['I', 'V', 'IV', 'IV'], moods: ['bright', 'tense'], mode: 'major' },
  { id: 'synthwave', label: 'i–bVII–bIII–bVI', bars: ['i', 'bVII', 'bIII', 'bVI'], moods: ['dark', 'epic'], mode: 'minor' },
  { id: 'kpop', label: 'vi–IV–I–V bright', bars: ['vi', 'IV', 'I', 'V'], moods: ['bright', 'wistful'], mode: 'major' },
  { id: 'afrobeat', label: 'I–ii–iii–IV', bars: ['I', 'iim7', 'iiim7', 'IV'], moods: ['bright', 'warm'], mode: 'major' },
  { id: 'cinematic-rise', label: 'i–iv–bVII–bIII', bars: ['i', 'iv', 'bVII', 'bIII'], moods: ['epic', 'tense'], mode: 'minor' },
  { id: 'chiptune', label: 'I–vi–ii–V', bars: ['I', 'vi', 'ii', 'V'], moods: ['bright'], mode: 'major' },
  { id: 'meditative', label: 'i–bIII', bars: ['i', 'i', 'bIII', 'bIII'], moods: ['wistful', 'warm'], mode: 'minor' },
]

const BY_ID = new Map(PROGRESSIONS.map((p) => [p.id, p]))

export function getProgression(id: string): ProgressionTemplate | undefined {
  return BY_ID.get(id)
}
