/**
 * Genre definitions. Every stylistic decision the composer makes — tempo,
 * scale, harmony pool, groove, instrumentation, arrangement density — is
 * looked up here, so adding a genre is a data change rather than a code change.
 */

import type { ScaleName } from '../theory/pitch'
import type { InstrumentId } from './types'

export type DrumStyle =
  | 'fourFloor' | 'boomBap' | 'trap' | 'drill' | 'rock' | 'pop' | 'breakbeat'
  | 'dnb' | 'halfTime' | 'shuffle' | 'latin' | 'reggaeton' | 'afrobeat'
  | 'jazzSwing' | 'ambient' | 'march' | 'disco' | 'punk' | 'metal' | 'bossa'
  | 'phonk' | 'chiptune' | 'waltz' | 'koplo' | 'none'

export type VocalStyle = 'sung' | 'rap' | 'chant' | 'none'

export interface GenreInstruments {
  chords: InstrumentId[]
  bass: InstrumentId[]
  lead: InstrumentId[]
  pad: InstrumentId[]
  arp: InstrumentId[]
  riff: InstrumentId[]
}

export interface GenreDef {
  id: string
  label: string
  family: string
  /** Words that map a free-text prompt onto this genre. */
  tags: string[]
  bpm: [number, number]
  beatsPerBar: number
  scales: ScaleName[]
  progressions: string[]
  drumStyle: DrumStyle
  /** 0..0.66 — how far off-beat subdivisions are pushed late. */
  swing: number
  /** Which subdivision swings: 8ths or 16ths. */
  swingSubdivision: 8 | 16
  /** 0..1 — overall note density of the generated arrangement. */
  density: number
  /** 0..1 — tone brightness, drives filter cutoffs at render time. */
  brightness: number
  instruments: GenreInstruments
  vocalStyle: VocalStyle
  /** Preferred section count; the arranger scales it to the target duration. */
  formStyle: 'song' | 'edm' | 'loop' | 'through' | 'ambient'
  /** Reverb size 0..1 for the master bus. */
  space: number
}

const G = (def: GenreDef): GenreDef => def

export const GENRES: GenreDef[] = [
  // Dangdut koplo. Kendang carries the groove, the bass dances rather than
  // holds, a clean guitar chops on the off-beats, and the suling — a bamboo
  // flute, closest here to the flute patch — answers the singer between lines.
  // Minor keys throughout: koplo is festive and serious at the same time.
  G({
    id: 'koplo', label: 'Dangdut Koplo', family: 'Indonesian',
    tags: ['dangdut', 'koplo', 'kendang', 'indonesian', 'jaipong', 'pargoy', 'orkes'],
    bpm: [98, 132], beatsPerBar: 4, scales: ['minor', 'harmonicMinor', 'dorian'],
    progressions: ['andalusian', 'minor-pop', 'axis-rot', 'anthem'],
    drumStyle: 'koplo', swing: 0.08, swingSubdivision: 16, density: 0.74, brightness: 0.7,
    instruments: {
      chords: ['organ', 'electricPiano'], bass: ['electricBass', 'synthBass'],
      lead: ['flute', 'sawLead'], pad: ['strings', 'warmPad'],
      arp: ['pluck', 'marimba'], riff: ['cleanGuitar', 'crunchGuitar'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.35,
  }),
  G({
    id: 'pop', label: 'Pop', family: 'Popular', tags: ['pop', 'catchy', 'radio', 'mainstream', 'upbeat'],
    bpm: [96, 124], beatsPerBar: 4, scales: ['major', 'minor', 'mixolydian'],
    progressions: ['axis', 'doo-wop', 'axis-rot', 'anthem', 'folk'],
    drumStyle: 'pop', swing: 0.04, swingSubdivision: 16, density: 0.6, brightness: 0.72,
    instruments: {
      chords: ['electricPiano', 'grandPiano', 'cleanGuitar'], bass: ['synthBass', 'electricBass'],
      lead: ['sawLead', 'pluck'], pad: ['warmPad', 'glassPad'], arp: ['pluck', 'bell'], riff: ['cleanGuitar', 'pluck'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.45,
  }),
  G({
    id: 'rock', label: 'Rock', family: 'Guitar', tags: ['rock', 'guitar', 'band', 'driving', 'classic rock'],
    bpm: [104, 152], beatsPerBar: 4, scales: ['minor', 'mixolydian', 'major', 'blues'],
    progressions: ['axis', 'plagal', 'country', 'minor-pop', 'punk'],
    drumStyle: 'rock', swing: 0, swingSubdivision: 8, density: 0.62, brightness: 0.66,
    instruments: {
      chords: ['crunchGuitar', 'organ'], bass: ['electricBass'], lead: ['distortedGuitar', 'organ'],
      pad: ['organ', 'strings'], arp: ['cleanGuitar'], riff: ['distortedGuitar', 'crunchGuitar'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.35,
  }),
  G({
    id: 'hiphop', label: 'Hip Hop', family: 'Urban', tags: ['hip hop', 'hiphop', 'rap', 'boom bap', 'old school'],
    bpm: [82, 96], beatsPerBar: 4, scales: ['minorPentatonic', 'minor', 'dorian'],
    progressions: ['lofi', 'trap-loop', 'minor-pop', 'rnb'],
    drumStyle: 'boomBap', swing: 0.16, swingSubdivision: 16, density: 0.5, brightness: 0.5,
    instruments: {
      chords: ['electricPiano', 'grandPiano'], bass: ['subBass', 'acousticBass'],
      lead: ['pluck', 'bell'], pad: ['warmPad', 'choirPad'], arp: ['bell'], riff: ['electricPiano'],
    },
    vocalStyle: 'rap', formStyle: 'loop', space: 0.4,
  }),
  G({
    id: 'trap', label: 'Trap', family: 'Urban', tags: ['trap', '808', 'hi hat rolls', 'dark rap'],
    bpm: [130, 156], beatsPerBar: 4, scales: ['minor', 'phrygian', 'harmonicMinor', 'minorPentatonic'],
    progressions: ['trap-loop', 'drill-loop', 'minor-4', 'aeolian-vamp'],
    drumStyle: 'trap', swing: 0, swingSubdivision: 16, density: 0.55, brightness: 0.45,
    instruments: {
      chords: ['bell', 'electricPiano'], bass: ['subBass'], lead: ['bell', 'pluck'],
      pad: ['choirPad', 'glassPad'], arp: ['bell'], riff: ['pluck'],
    },
    vocalStyle: 'rap', formStyle: 'loop', space: 0.5,
  }),
  G({
    id: 'drill', label: 'Drill', family: 'Urban', tags: ['drill', 'uk drill', 'sliding 808', 'menacing'],
    bpm: [138, 148], beatsPerBar: 4, scales: ['harmonicMinor', 'phrygian', 'minor'],
    progressions: ['drill-loop', 'andalusian', 'minor-4'],
    drumStyle: 'drill', swing: 0, swingSubdivision: 16, density: 0.5, brightness: 0.4,
    instruments: {
      chords: ['bell', 'harp'], bass: ['subBass'], lead: ['bell', 'flute'],
      pad: ['choirPad'], arp: ['harp'], riff: ['bell'],
    },
    vocalStyle: 'rap', formStyle: 'loop', space: 0.45,
  }),
  G({
    id: 'phonk', label: 'Phonk', family: 'Urban', tags: ['phonk', 'memphis', 'cowbell', 'drift'],
    bpm: [130, 150], beatsPerBar: 4, scales: ['minor', 'phrygian', 'minorPentatonic'],
    progressions: ['trap-loop', 'aeolian-vamp', 'metal'],
    drumStyle: 'phonk', swing: 0.08, swingSubdivision: 16, density: 0.52, brightness: 0.38,
    instruments: {
      chords: ['electricPiano'], bass: ['subBass', 'synthBass'], lead: ['bell', 'sawLead'],
      pad: ['choirPad'], arp: ['bell'], riff: ['bell'],
    },
    vocalStyle: 'rap', formStyle: 'loop', space: 0.55,
  }),
  G({
    id: 'rnb', label: 'R&B / Soul', family: 'Urban', tags: ['rnb', 'r&b', 'soul', 'smooth', 'sensual', 'neo soul'],
    bpm: [68, 96], beatsPerBar: 4, scales: ['minor', 'dorian', 'major'],
    progressions: ['rnb', 'jazz-turn', 'lofi', 'gospel'],
    drumStyle: 'halfTime', swing: 0.14, swingSubdivision: 16, density: 0.55, brightness: 0.58,
    instruments: {
      chords: ['electricPiano', 'grandPiano'], bass: ['electricBass', 'subBass'],
      lead: ['electricPiano', 'pluck'], pad: ['warmPad', 'choirPad'], arp: ['bell'], riff: ['cleanGuitar'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.5,
  }),
  G({
    id: 'lofi', label: 'Lo-fi Chill', family: 'Chill', tags: ['lofi', 'lo-fi', 'chill', 'study', 'relax', 'chillhop', 'sleepy'],
    bpm: [66, 88], beatsPerBar: 4, scales: ['dorian', 'minor', 'major'],
    progressions: ['lofi', 'jazz-turn', 'rnb', 'bossa'],
    drumStyle: 'boomBap', swing: 0.2, swingSubdivision: 16, density: 0.42, brightness: 0.34,
    instruments: {
      chords: ['electricPiano', 'grandPiano'], bass: ['acousticBass', 'electricBass'],
      lead: ['marimba', 'bell'], pad: ['warmPad'], arp: ['bell'], riff: ['nylonGuitar'],
    },
    vocalStyle: 'none', formStyle: 'loop', space: 0.55,
  }),
  G({
    id: 'house', label: 'House', family: 'Electronic', tags: ['house', 'deep house', 'club', 'dance', 'four on the floor'],
    bpm: [118, 128], beatsPerBar: 4, scales: ['minor', 'dorian', 'minorPentatonic'],
    progressions: ['house-vamp', 'minor-pop', 'lofi', 'aeolian-vamp'],
    drumStyle: 'fourFloor', swing: 0.06, swingSubdivision: 16, density: 0.68, brightness: 0.68,
    instruments: {
      chords: ['electricPiano', 'organ'], bass: ['synthBass', 'subBass'],
      lead: ['pluck', 'sawLead'], pad: ['warmPad', 'glassPad'], arp: ['pluck'], riff: ['pluck'],
    },
    vocalStyle: 'sung', formStyle: 'edm', space: 0.55,
  }),
  G({
    id: 'techno', label: 'Techno', family: 'Electronic', tags: ['techno', 'warehouse', 'hypnotic', 'industrial', 'peak time'],
    bpm: [128, 140], beatsPerBar: 4, scales: ['minor', 'phrygian', 'locrian'],
    progressions: ['meditative', 'aeolian-vamp', 'metal'],
    drumStyle: 'fourFloor', swing: 0, swingSubdivision: 16, density: 0.7, brightness: 0.6,
    instruments: {
      chords: ['sawLead', 'glassPad'], bass: ['reeseBass', 'synthBass'],
      lead: ['sawLead', 'squareLead'], pad: ['glassPad', 'noiseSweep'], arp: ['squareLead'], riff: ['sawLead'],
    },
    vocalStyle: 'none', formStyle: 'edm', space: 0.6,
  }),
  G({
    id: 'edm', label: 'EDM / Festival', family: 'Electronic', tags: ['edm', 'festival', 'big room', 'drop', 'anthem', 'energetic'],
    bpm: [126, 132], beatsPerBar: 4, scales: ['minor', 'major', 'mixolydian'],
    progressions: ['anthem', 'axis-rot', 'epic', 'synthwave'],
    drumStyle: 'fourFloor', swing: 0, swingSubdivision: 16, density: 0.75, brightness: 0.8,
    instruments: {
      chords: ['sawLead', 'glassPad'], bass: ['synthBass', 'subBass'],
      lead: ['sawLead', 'squareLead'], pad: ['glassPad', 'choirPad'], arp: ['pluck'], riff: ['sawLead'],
    },
    vocalStyle: 'sung', formStyle: 'edm', space: 0.65,
  }),
  G({
    id: 'dnb', label: 'Drum & Bass', family: 'Electronic', tags: ['dnb', 'drum and bass', 'jungle', 'liquid', 'fast breaks'],
    bpm: [168, 176], beatsPerBar: 4, scales: ['minor', 'dorian', 'minorPentatonic'],
    progressions: ['lofi', 'house-vamp', 'minor-pop'],
    drumStyle: 'dnb', swing: 0, swingSubdivision: 16, density: 0.72, brightness: 0.7,
    instruments: {
      chords: ['electricPiano', 'glassPad'], bass: ['reeseBass', 'subBass'],
      lead: ['pluck', 'bell'], pad: ['warmPad', 'glassPad'], arp: ['pluck'], riff: ['pluck'],
    },
    vocalStyle: 'none', formStyle: 'edm', space: 0.6,
  }),
  G({
    id: 'dubstep', label: 'Dubstep / Bass', family: 'Electronic', tags: ['dubstep', 'bass music', 'wobble', 'heavy', 'riddim'],
    bpm: [138, 146], beatsPerBar: 4, scales: ['minor', 'phrygian', 'locrian'],
    progressions: ['metal', 'aeolian-vamp', 'cinematic-rise'],
    drumStyle: 'halfTime', swing: 0, swingSubdivision: 16, density: 0.62, brightness: 0.55,
    instruments: {
      chords: ['glassPad', 'sawLead'], bass: ['reeseBass', 'subBass'],
      lead: ['sawLead', 'squareLead'], pad: ['noiseSweep', 'choirPad'], arp: ['squareLead'], riff: ['reeseBass'],
    },
    vocalStyle: 'none', formStyle: 'edm', space: 0.6,
  }),
  G({
    id: 'synthwave', label: 'Synthwave', family: 'Electronic', tags: ['synthwave', 'retrowave', '80s', 'outrun', 'neon', 'nostalgic'],
    bpm: [96, 118], beatsPerBar: 4, scales: ['minor', 'dorian', 'major'],
    progressions: ['synthwave', 'aeolian-vamp', 'axis-rot'],
    drumStyle: 'pop', swing: 0, swingSubdivision: 16, density: 0.62, brightness: 0.62,
    instruments: {
      chords: ['sawLead', 'glassPad'], bass: ['synthBass'], lead: ['sawLead', 'squareLead'],
      pad: ['glassPad', 'warmPad'], arp: ['squareLead', 'pluck'], riff: ['sawLead'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.7,
  }),
  G({
    id: 'ambient', label: 'Ambient', family: 'Atmospheric', tags: ['ambient', 'atmospheric', 'drone', 'calm', 'meditation', 'peaceful', 'spa'],
    bpm: [56, 76], beatsPerBar: 4, scales: ['lydian', 'major', 'dorian', 'majorPentatonic'],
    progressions: ['ambient', 'meditative', 'plagal'],
    drumStyle: 'ambient', swing: 0, swingSubdivision: 8, density: 0.22, brightness: 0.42,
    instruments: {
      chords: ['glassPad', 'warmPad'], bass: ['subBass', 'cello'], lead: ['flute', 'bell'],
      pad: ['warmPad', 'choirPad', 'glassPad'], arp: ['bell', 'harp'], riff: ['harp'],
    },
    vocalStyle: 'none', formStyle: 'ambient', space: 0.9,
  }),
  G({
    id: 'cinematic', label: 'Cinematic / Trailer', family: 'Score', tags: ['cinematic', 'trailer', 'epic', 'film', 'orchestral', 'dramatic', 'heroic'],
    bpm: [72, 104], beatsPerBar: 4, scales: ['minor', 'harmonicMinor', 'dorian', 'phrygian'],
    progressions: ['epic', 'cinematic-rise', 'aeolian-vamp', 'minor-4'],
    drumStyle: 'march', swing: 0, swingSubdivision: 8, density: 0.55, brightness: 0.5,
    instruments: {
      chords: ['strings', 'brass'], bass: ['cello', 'subBass'], lead: ['brass', 'violin'],
      pad: ['choirPad', 'strings'], arp: ['harp', 'bell'], riff: ['strings'],
    },
    vocalStyle: 'none', formStyle: 'through', space: 0.85,
  }),
  G({
    id: 'classical', label: 'Classical', family: 'Score', tags: ['classical', 'piano', 'orchestra', 'baroque', 'romantic', 'chamber'],
    bpm: [64, 108], beatsPerBar: 4, scales: ['major', 'minor', 'harmonicMinor'],
    progressions: ['canon', 'jazz-251', 'plagal', 'minor-251'],
    drumStyle: 'none', swing: 0, swingSubdivision: 8, density: 0.6, brightness: 0.55,
    instruments: {
      chords: ['grandPiano', 'strings'], bass: ['cello'], lead: ['violin', 'flute'],
      pad: ['strings'], arp: ['harp', 'grandPiano'], riff: ['grandPiano'],
    },
    vocalStyle: 'none', formStyle: 'through', space: 0.75,
  }),
  G({
    id: 'jazz', label: 'Jazz', family: 'Roots', tags: ['jazz', 'swing', 'bebop', 'smoky', 'lounge', 'improvisation'],
    bpm: [92, 168], beatsPerBar: 4, scales: ['dorian', 'mixolydian', 'major', 'melodicMinor'],
    progressions: ['jazz-251', 'jazz-turn', 'minor-251', 'blues-12'],
    drumStyle: 'jazzSwing', swing: 0.34, swingSubdivision: 8, density: 0.62, brightness: 0.55,
    instruments: {
      chords: ['grandPiano', 'electricPiano'], bass: ['acousticBass'], lead: ['brass', 'flute'],
      pad: ['strings'], arp: ['grandPiano'], riff: ['grandPiano'],
    },
    vocalStyle: 'sung', formStyle: 'through', space: 0.5,
  }),
  G({
    id: 'bossa', label: 'Bossa Nova', family: 'Roots', tags: ['bossa', 'bossa nova', 'samba', 'brazil', 'latin jazz', 'beach'],
    bpm: [116, 142], beatsPerBar: 4, scales: ['major', 'dorian', 'melodicMinor'],
    progressions: ['bossa', 'jazz-turn', 'jazz-251'],
    drumStyle: 'bossa', swing: 0.08, swingSubdivision: 16, density: 0.5, brightness: 0.6,
    instruments: {
      chords: ['nylonGuitar', 'electricPiano'], bass: ['acousticBass'], lead: ['flute', 'nylonGuitar'],
      pad: ['strings'], arp: ['nylonGuitar'], riff: ['nylonGuitar'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.45,
  }),
  G({
    id: 'blues', label: 'Blues', family: 'Roots', tags: ['blues', '12 bar', 'delta', 'shuffle', 'harmonica'],
    bpm: [72, 116], beatsPerBar: 4, scales: ['blues', 'minorPentatonic', 'mixolydian'],
    progressions: ['blues-12'],
    drumStyle: 'shuffle', swing: 0.32, swingSubdivision: 8, density: 0.55, brightness: 0.5,
    instruments: {
      chords: ['crunchGuitar', 'organ'], bass: ['electricBass', 'acousticBass'],
      lead: ['crunchGuitar', 'organ'], pad: ['organ'], arp: ['cleanGuitar'], riff: ['crunchGuitar'],
    },
    vocalStyle: 'sung', formStyle: 'through', space: 0.4,
  }),
  G({
    id: 'country', label: 'Country', family: 'Roots', tags: ['country', 'nashville', 'americana', 'honky tonk', 'truck'],
    bpm: [92, 132], beatsPerBar: 4, scales: ['major', 'mixolydian', 'majorPentatonic'],
    progressions: ['country', 'folk', 'axis', 'doo-wop'],
    drumStyle: 'rock', swing: 0.1, swingSubdivision: 8, density: 0.55, brightness: 0.68,
    instruments: {
      chords: ['cleanGuitar', 'nylonGuitar'], bass: ['acousticBass', 'electricBass'],
      lead: ['cleanGuitar', 'violin'], pad: ['strings', 'organ'], arp: ['cleanGuitar'], riff: ['cleanGuitar'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.45,
  }),
  G({
    id: 'folk', label: 'Folk / Acoustic', family: 'Roots', tags: ['folk', 'acoustic', 'indie folk', 'campfire', 'singer songwriter', 'gentle'],
    bpm: [82, 118], beatsPerBar: 4, scales: ['major', 'dorian', 'minor', 'majorPentatonic'],
    progressions: ['folk', 'axis', 'plagal', 'axis-rot'],
    drumStyle: 'pop', swing: 0.05, swingSubdivision: 8, density: 0.45, brightness: 0.62,
    instruments: {
      chords: ['nylonGuitar', 'cleanGuitar'], bass: ['acousticBass'], lead: ['cleanGuitar', 'flute'],
      pad: ['strings', 'warmPad'], arp: ['nylonGuitar', 'harp'], riff: ['nylonGuitar'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.5,
  }),
  G({
    id: 'gospel', label: 'Gospel', family: 'Roots', tags: ['gospel', 'choir', 'church', 'uplifting', 'praise', 'soulful'],
    bpm: [72, 108], beatsPerBar: 4, scales: ['major', 'mixolydian'],
    progressions: ['gospel', 'jazz-turn', 'doo-wop'],
    drumStyle: 'shuffle', swing: 0.22, swingSubdivision: 8, density: 0.6, brightness: 0.62,
    instruments: {
      chords: ['organ', 'grandPiano'], bass: ['electricBass'], lead: ['organ', 'brass'],
      pad: ['choirPad'], arp: ['grandPiano'], riff: ['organ'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.6,
  }),
  G({
    id: 'reggae', label: 'Reggae', family: 'World', tags: ['reggae', 'dub', 'ska', 'island', 'skank', 'jamaica'],
    bpm: [72, 96], beatsPerBar: 4, scales: ['minor', 'major', 'dorian'],
    progressions: ['minor-pop', 'plagal', 'axis'],
    drumStyle: 'halfTime', swing: 0.1, swingSubdivision: 8, density: 0.48, brightness: 0.55,
    instruments: {
      chords: ['organ', 'cleanGuitar'], bass: ['electricBass'], lead: ['organ', 'brass'],
      pad: ['warmPad'], arp: ['cleanGuitar'], riff: ['cleanGuitar'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.7,
  }),
  G({
    id: 'reggaeton', label: 'Reggaeton / Latin', family: 'World', tags: ['reggaeton', 'latin', 'dembow', 'perreo', 'spanish', 'summer'],
    bpm: [88, 100], beatsPerBar: 4, scales: ['minor', 'harmonicMinor', 'phrygian'],
    progressions: ['reggaeton', 'andalusian', 'minor-pop'],
    drumStyle: 'reggaeton', swing: 0, swingSubdivision: 16, density: 0.6, brightness: 0.62,
    instruments: {
      chords: ['nylonGuitar', 'electricPiano'], bass: ['subBass', 'synthBass'],
      lead: ['pluck', 'sawLead'], pad: ['warmPad'], arp: ['pluck'], riff: ['nylonGuitar'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.5,
  }),
  G({
    id: 'afrobeats', label: 'Afrobeats', family: 'World', tags: ['afrobeats', 'afro', 'amapiano', 'african', 'log drum', 'sunny'],
    bpm: [98, 114], beatsPerBar: 4, scales: ['major', 'minor', 'dorian', 'majorPentatonic'],
    progressions: ['afrobeat', 'axis', 'lofi'],
    drumStyle: 'afrobeat', swing: 0.12, swingSubdivision: 16, density: 0.6, brightness: 0.68,
    instruments: {
      chords: ['electricPiano', 'marimba'], bass: ['subBass', 'electricBass'],
      lead: ['marimba', 'pluck'], pad: ['warmPad'], arp: ['marimba'], riff: ['pluck'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.5,
  }),
  G({
    id: 'kpop', label: 'K-Pop', family: 'Popular', tags: ['kpop', 'k-pop', 'idol', 'korean', 'bright pop', 'girl group'],
    bpm: [108, 132], beatsPerBar: 4, scales: ['major', 'minor', 'mixolydian'],
    progressions: ['kpop', 'axis', 'anthem', 'doo-wop'],
    drumStyle: 'pop', swing: 0.03, swingSubdivision: 16, density: 0.72, brightness: 0.8,
    instruments: {
      chords: ['electricPiano', 'sawLead'], bass: ['synthBass', 'subBass'],
      lead: ['pluck', 'sawLead'], pad: ['glassPad', 'choirPad'], arp: ['pluck', 'bell'], riff: ['pluck'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.5,
  }),
  G({
    id: 'jpop', label: 'J-Pop / Anime', family: 'Popular', tags: ['jpop', 'j-pop', 'anime', 'japanese', 'opening', 'city pop'],
    bpm: [124, 168], beatsPerBar: 4, scales: ['major', 'lydian', 'minor'],
    progressions: ['canon', 'kpop', 'axis', 'jazz-turn'],
    drumStyle: 'rock', swing: 0, swingSubdivision: 16, density: 0.75, brightness: 0.78,
    instruments: {
      chords: ['grandPiano', 'crunchGuitar'], bass: ['electricBass'],
      lead: ['sawLead', 'violin'], pad: ['glassPad', 'strings'], arp: ['bell', 'pluck'], riff: ['distortedGuitar'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.55,
  }),
  G({
    id: 'metal', label: 'Metal', family: 'Guitar', tags: ['metal', 'heavy', 'djent', 'aggressive', 'thrash', 'brutal'],
    bpm: [140, 190], beatsPerBar: 4, scales: ['phrygian', 'harmonicMinor', 'minor', 'locrian'],
    progressions: ['metal', 'andalusian', 'aeolian-vamp'],
    drumStyle: 'metal', swing: 0, swingSubdivision: 16, density: 0.8, brightness: 0.6,
    instruments: {
      chords: ['distortedGuitar'], bass: ['electricBass', 'reeseBass'],
      lead: ['distortedGuitar', 'sawLead'], pad: ['choirPad', 'strings'], arp: ['distortedGuitar'], riff: ['distortedGuitar'],
    },
    vocalStyle: 'chant', formStyle: 'song', space: 0.4,
  }),
  G({
    id: 'punk', label: 'Punk / Pop-Punk', family: 'Guitar', tags: ['punk', 'pop punk', 'fast', 'garage', 'skate', 'emo'],
    bpm: [156, 192], beatsPerBar: 4, scales: ['major', 'mixolydian', 'minor'],
    progressions: ['punk', 'axis', 'doo-wop'],
    drumStyle: 'punk', swing: 0, swingSubdivision: 8, density: 0.72, brightness: 0.7,
    instruments: {
      chords: ['crunchGuitar', 'distortedGuitar'], bass: ['electricBass'],
      lead: ['distortedGuitar'], pad: ['organ'], arp: ['cleanGuitar'], riff: ['distortedGuitar'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.35,
  }),
  G({
    id: 'indie', label: 'Indie / Dream Pop', family: 'Popular', tags: ['indie', 'dream pop', 'shoegaze', 'bedroom', 'hazy', 'reverb'],
    bpm: [88, 122], beatsPerBar: 4, scales: ['major', 'lydian', 'dorian', 'minor'],
    progressions: ['axis-rot', 'folk', 'ambient', 'rnb'],
    drumStyle: 'pop', swing: 0.06, swingSubdivision: 8, density: 0.5, brightness: 0.52,
    instruments: {
      chords: ['cleanGuitar', 'electricPiano'], bass: ['electricBass'],
      lead: ['cleanGuitar', 'bell'], pad: ['warmPad', 'glassPad'], arp: ['cleanGuitar'], riff: ['cleanGuitar'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.75,
  }),
  G({
    id: 'disco', label: 'Disco / Funk', family: 'Popular', tags: ['disco', 'funk', 'groove', 'seventies', 'dancefloor', 'nu disco'],
    bpm: [110, 126], beatsPerBar: 4, scales: ['dorian', 'mixolydian', 'minor'],
    progressions: ['house-vamp', 'jazz-turn', 'lofi'],
    drumStyle: 'disco', swing: 0.08, swingSubdivision: 16, density: 0.72, brightness: 0.72,
    instruments: {
      chords: ['cleanGuitar', 'electricPiano'], bass: ['electricBass', 'synthBass'],
      lead: ['brass', 'sawLead'], pad: ['strings'], arp: ['pluck'], riff: ['cleanGuitar'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.5,
  }),
  G({
    id: 'chiptune', label: 'Chiptune / 8-bit', family: 'Electronic', tags: ['chiptune', '8 bit', '8-bit', 'retro game', 'nes', 'arcade', 'pixel'],
    bpm: [124, 172], beatsPerBar: 4, scales: ['major', 'minor', 'lydian', 'majorPentatonic'],
    progressions: ['chiptune', 'canon', 'axis'],
    drumStyle: 'chiptune', swing: 0, swingSubdivision: 16, density: 0.78, brightness: 0.85,
    instruments: {
      chords: ['chiptune'], bass: ['chiptune', 'squareLead'], lead: ['chiptune', 'squareLead'],
      pad: ['chiptune'], arp: ['chiptune'], riff: ['chiptune'],
    },
    vocalStyle: 'none', formStyle: 'loop', space: 0.3,
  }),
  G({
    id: 'corporate', label: 'Corporate / Background', family: 'Utility', tags: ['corporate', 'background', 'presentation', 'commercial', 'motivational', 'podcast', 'vlog'],
    bpm: [100, 124], beatsPerBar: 4, scales: ['major', 'lydian', 'majorPentatonic'],
    progressions: ['plagal', 'folk', 'axis', 'anthem'],
    drumStyle: 'pop', swing: 0, swingSubdivision: 16, density: 0.5, brightness: 0.72,
    instruments: {
      chords: ['grandPiano', 'cleanGuitar'], bass: ['electricBass', 'subBass'],
      lead: ['bell', 'marimba'], pad: ['warmPad', 'strings'], arp: ['pluck', 'marimba'], riff: ['pluck'],
    },
    vocalStyle: 'none', formStyle: 'loop', space: 0.5,
  }),
  G({
    id: 'lullaby', label: 'Lullaby / Kids', family: 'Utility', tags: ['lullaby', 'kids', 'children', 'sleep', 'music box', 'nursery', 'baby'],
    bpm: [64, 84], beatsPerBar: 3, scales: ['major', 'majorPentatonic', 'lydian'],
    progressions: ['plagal', 'canon', 'folk'],
    drumStyle: 'waltz', swing: 0, swingSubdivision: 8, density: 0.34, brightness: 0.6,
    instruments: {
      chords: ['harp', 'grandPiano'], bass: ['cello'], lead: ['bell', 'flute'],
      pad: ['warmPad', 'choirPad'], arp: ['bell', 'harp'], riff: ['bell'],
    },
    vocalStyle: 'sung', formStyle: 'song', space: 0.7,
  }),
  G({
    id: 'world', label: 'World Fusion', family: 'World', tags: ['world', 'ethnic', 'sitar', 'bollywood', 'india', 'desert', 'fusion'],
    bpm: [82, 124], beatsPerBar: 4, scales: ['phrygianDominant', 'harmonicMinor', 'dorian', 'japanese'],
    progressions: ['andalusian', 'meditative', 'minor-4'],
    drumStyle: 'latin', swing: 0.08, swingSubdivision: 16, density: 0.58, brightness: 0.6,
    instruments: {
      chords: ['sitar', 'accordion'], bass: ['acousticBass', 'subBass'],
      lead: ['sitar', 'flute'], pad: ['choirPad', 'strings'], arp: ['harp', 'sitar'], riff: ['sitar'],
    },
    vocalStyle: 'chant', formStyle: 'through', space: 0.7,
  }),
]

const BY_ID = new Map(GENRES.map((g) => [g.id, g]))

export function getGenre(id: string): GenreDef {
  return BY_ID.get(id) ?? GENRES[0]!
}

export const GENRE_FAMILIES = [...new Set(GENRES.map((g) => g.family))]
