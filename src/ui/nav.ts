/** The tool list, shared by the sidebar, the mobile tab bar and the home grid. */

import type { IconName } from './components/Icon'

export interface ToolRoute {
  path: string
  label: string
  /** Short label for the mobile tab bar. */
  short: string
  icon: IconName
  blurb: string
  /** Shown on the mobile tab bar (the first five). */
  primary: boolean
}

export const TOOLS: ToolRoute[] = [
  {
    path: '/',
    label: 'Song Studio',
    short: 'Studio',
    icon: 'studio',
    blurb: 'Describe a song and get a finished track — arrangement, instruments, vocals and lyrics.',
    primary: true,
  },
  {
    path: '/lyrics',
    label: 'Lyric Writer',
    short: 'Lyrics',
    icon: 'lyrics',
    blurb: 'Structured, rhyming, metered lyrics for any theme — then sing them.',
    primary: true,
  },
  {
    path: '/voice',
    label: 'Text to Speech',
    short: 'Speech',
    icon: 'voice',
    blurb: 'Eight built-in voices with full control over pitch, pace and delivery.',
    primary: true,
  },
  {
    path: '/stems',
    label: 'Stem Splitter',
    short: 'Stems',
    icon: 'stems',
    blurb: 'Pull vocals, drums, bass and everything else out of any track.',
    primary: true,
  },
  {
    path: '/shifter',
    label: 'Voice Changer',
    short: 'Voice',
    icon: 'shifter',
    blurb: 'Shift pitch and vocal character independently, with ten ready-made characters.',
    primary: true,
  },
  {
    path: '/toolkit',
    label: 'Audio Toolkit',
    short: 'Tools',
    icon: 'toolkit',
    blurb: 'Trim, fade, normalise, EQ, denoise, add space, and read tempo, key and loudness.',
    primary: false,
  },
  {
    path: '/library',
    label: 'Library',
    short: 'Library',
    icon: 'library',
    blurb: 'Everything you have made, stored on this device.',
    primary: false,
  },
]

export function toolFor(path: string): ToolRoute | undefined {
  return TOOLS.find((tool) => tool.path === path)
}
