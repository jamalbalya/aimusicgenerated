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
}

export const PROGRESSIONS: ProgressionTemplate[] = [
  { id: 'axis', label: 'I–V–vi–IV', bars: ['I', 'V', 'vi', 'IV'], moods: ['bright', 'warm'] },
  { id: 'axis-rot', label: 'vi–IV–I–V', bars: ['vi', 'IV', 'I', 'V'], moods: ['wistful', 'warm'] },
  { id: 'doo-wop', label: 'I–vi–IV–V', bars: ['I', 'vi', 'IV', 'V'], moods: ['bright', 'warm'] },
  { id: 'canon', label: 'I–V–vi–iii–IV–I–IV–V', bars: ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'], moods: ['warm', 'epic'] },
  { id: 'andalusian', label: 'i–bVII–bVI–V', bars: ['i', 'bVII', 'bVI', 'V'], moods: ['dark', 'tense'] },
  { id: 'aeolian-vamp', label: 'i–bVI–bIII–bVII', bars: ['i', 'bVI', 'bIII', 'bVII'], moods: ['dark', 'epic'] },
  { id: 'minor-pop', label: 'i–bVII–bVI–bVII', bars: ['i', 'bVII', 'bVI', 'bVII'], moods: ['dark', 'wistful'] },
  { id: 'minor-4', label: 'i–iv–bVI–V', bars: ['i', 'iv', 'bVI', 'V'], moods: ['dark', 'tense'] },
  { id: 'plagal', label: 'I–IV–I–V', bars: ['I', 'IV', 'I', 'V'], moods: ['bright'] },
  { id: 'jazz-251', label: 'ii7–V7–Imaj7', bars: ['iim7', 'V7', 'Imaj7', 'Imaj7'], moods: ['warm'] },
  { id: 'jazz-turn', label: 'Imaj7–vi7–ii7–V7', bars: ['Imaj7', 'vim7', 'iim7', 'V7'], moods: ['warm', 'wistful'] },
  { id: 'minor-251', label: 'iim7b5–V7–i', bars: ['iim7b5', 'V7', 'i', 'i'], moods: ['dark', 'tense'] },
  { id: 'blues-12', label: '12-bar blues', bars: ['I7', 'I7', 'I7', 'I7', 'IV7', 'IV7', 'I7', 'I7', 'V7', 'IV7', 'I7', 'V7'], moods: ['warm', 'dark'] },
  { id: 'trap-loop', label: 'i–bVI–bVII–i', bars: ['i', 'bVI', 'bVII', 'i'], moods: ['dark'] },
  { id: 'drill-loop', label: 'i–bIII–bVII–iv', bars: ['i', 'bIII', 'bVII', 'iv'], moods: ['dark', 'tense'] },
  { id: 'house-vamp', label: 'i–bVII–bVI–bVII', bars: ['im7', 'bVII', 'bVImaj7', 'bVII'], moods: ['dark', 'warm'] },
  { id: 'lofi', label: 'ii7–V7–iii7–vi7', bars: ['iim7', 'V7', 'iiim7', 'vim7'], moods: ['wistful', 'warm'] },
  { id: 'epic', label: 'i–bVI–bIII–bVII (epic)', bars: ['i', 'bVI', 'bIII', 'bVII'], moods: ['epic', 'dark'] },
  { id: 'anthem', label: 'IV–I–V–vi', bars: ['IV', 'I', 'V', 'vi'], moods: ['epic', 'bright'] },
  { id: 'folk', label: 'I–IV–vi–V', bars: ['I', 'IV', 'vi', 'V'], moods: ['warm', 'bright'] },
  { id: 'country', label: 'I–IV–V–IV', bars: ['I', 'IV', 'V', 'IV'], moods: ['bright', 'warm'] },
  { id: 'rnb', label: 'Imaj7–iii7–vi7–IV', bars: ['Imaj7', 'iiim7', 'vim7', 'IV'], moods: ['warm', 'wistful'] },
  { id: 'gospel', label: 'I–iii–IV–iv', bars: ['I', 'iii', 'IV', 'iv'], moods: ['warm', 'epic'] },
  { id: 'reggaeton', label: 'i–bVII–bVI–V', bars: ['i', 'bVII', 'bVI', 'V'], moods: ['dark', 'warm'] },
  { id: 'bossa', label: 'Imaj7–ii7–V7–Imaj7', bars: ['Imaj7', 'iim7', 'V7', 'Imaj7'], moods: ['warm'] },
  { id: 'ambient', label: 'Isus2–IVsus2', bars: ['Isus2', 'Isus2', 'IVsus2', 'IVsus2'], moods: ['warm', 'wistful'] },
  { id: 'metal', label: 'i–bVI–bVII–bV', bars: ['i', 'bVI', 'bVII', 'bVI'], moods: ['dark', 'tense'] },
  { id: 'punk', label: 'I–V–vi–IV fast', bars: ['I', 'V', 'IV', 'IV'], moods: ['bright', 'tense'] },
  { id: 'synthwave', label: 'i–bVII–bIII–bVI', bars: ['i', 'bVII', 'bIII', 'bVI'], moods: ['dark', 'epic'] },
  { id: 'kpop', label: 'vi–IV–I–V bright', bars: ['vi', 'IV', 'I', 'V'], moods: ['bright', 'wistful'] },
  { id: 'afrobeat', label: 'I–ii–iii–IV', bars: ['I', 'iim7', 'iiim7', 'IV'], moods: ['bright', 'warm'] },
  { id: 'cinematic-rise', label: 'i–iv–bVII–bIII', bars: ['i', 'iv', 'bVII', 'bIII'], moods: ['epic', 'tense'] },
  { id: 'chiptune', label: 'I–vi–ii–V', bars: ['I', 'vi', 'ii', 'V'], moods: ['bright'] },
  { id: 'meditative', label: 'i–bIII', bars: ['i', 'i', 'bIII', 'bIII'], moods: ['wistful', 'warm'] },
]

const BY_ID = new Map(PROGRESSIONS.map((p) => [p.id, p]))

export function getProgression(id: string): ProgressionTemplate | undefined {
  return BY_ID.get(id)
}
