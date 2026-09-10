/**
 * Icons, drawn as thin single-stroke geometry.
 *
 * They are hand-written rather than pulled from a set so they share one weight
 * and one corner treatment with the rest of the interface, and so the bundle
 * carries exactly the fourteen glyphs the app actually uses.
 */

export type IconName =
  | 'studio' | 'lyrics' | 'voice' | 'shifter' | 'stems' | 'toolkit' | 'library'
  | 'play' | 'pause' | 'stop' | 'download' | 'upload' | 'dice' | 'sun' | 'moon'
  | 'close' | 'check' | 'chevron' | 'wave' | 'info' | 'trash' | 'more'

const PATHS: Record<IconName, string> = {
  // A fader and a signal path.
  studio: 'M3 5h18M3 12h18M3 19h18M8 3v4M15 10v4M6 17v4',
  lyrics: 'M4 4h16M4 9h11M4 14h16M4 19h8',
  voice: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3ZM5 11a7 7 0 0 0 14 0M12 18v3',
  shifter: 'M4 18V9m5 9V5m5 13v-6m5 6V7M3 21h18',
  stems: 'M4 6h16M4 12h10M4 18h6M20 12v6M16 18h8',
  toolkit: 'M3 12h3l2-6 3 12 3-9 2 5h5',
  library: 'M4 4h4v16H4zM10 4h4v16h-4zM17 5l3 15',
  play: 'M7 4l13 8-13 8z',
  pause: 'M8 4v16M16 4v16',
  stop: 'M5 5h14v14H5z',
  download: 'M12 3v12m0 0 4-4m-4 4-4-4M4 19h16',
  upload: 'M12 21V9m0 0 4 4m-4-4L8 13M4 5h16',
  dice: 'M4 4h16v16H4zM9 9h.01M15 15h.01M12 12h.01',
  sun: 'M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12ZM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M4 12l5 5L20 6',
  chevron: 'M9 5l7 7-7 7',
  wave: 'M2 12h2l2-7 3 14 3-11 3 8 2-4h5',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 11v6M12 7.5h.01',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
}

const FILLED = new Set<IconName>(['play', 'stop'])

interface IconProps {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
}

export function Icon({ name, size = 16, className, strokeWidth = 1.6 }: IconProps) {
  const filled = FILLED.has(name)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
