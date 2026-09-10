/**
 * Waveform display with a playhead and click-to-seek.
 *
 * Peaks are computed once per audio buffer and cached, then drawn to a canvas
 * at device resolution — a three-minute render is millions of samples, so
 * re-scanning them on every animation frame is not an option.
 */

import { useEffect, useMemo, useRef } from 'react'
import { waveformPeaks } from '../../engine/audio/analyze'
import type { AudioData } from '../../engine/audio/wav'

interface WaveformProps {
  audio: AudioData | null
  /** 0..1 playback position. */
  progress: number
  height?: number
  onSeek?: (fraction: number) => void
  /** Section boundaries as 0..1 fractions, drawn as hairlines. */
  markers?: { position: number; label: string }[]
  className?: string
}

const COLUMNS = 1400

export function Waveform({ audio, progress, height = 76, onSeek, markers, className }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const peaks = useMemo(() => (audio ? waveformPeaks(audio, COLUMNS) : null), [audio])

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const draw = (): void => {
      const width = container.clientWidth
      if (width === 0) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, width, height)

      const styles = getComputedStyle(document.documentElement)
      const line = styles.getPropertyValue('--line').trim() || '#23272e'
      const dim = styles.getPropertyValue('--text-faint').trim() || '#676e78'
      const accent = styles.getPropertyValue('--accent').trim() || '#e9a13b'

      const middle = height / 2

      // Centre line first, so a silent buffer still reads as a waveform view.
      ctx.strokeStyle = line
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, middle)
      ctx.lineTo(width, middle)
      ctx.stroke()

      if (peaks) {
        const playedX = progress * width
        for (let x = 0; x < width; x++) {
          const column = Math.min(COLUMNS - 1, Math.floor((x / width) * COLUMNS))
          const min = peaks[column * 2]!
          const max = peaks[column * 2 + 1]!
          const top = middle - max * middle * 0.94
          const bottom = middle - min * middle * 0.94
          ctx.strokeStyle = x <= playedX ? accent : dim
          ctx.globalAlpha = x <= playedX ? 0.95 : 0.5
          ctx.beginPath()
          ctx.moveTo(x + 0.5, Math.min(top, middle - 0.5))
          ctx.lineTo(x + 0.5, Math.max(bottom, middle + 0.5))
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      }

      if (markers) {
        ctx.strokeStyle = line
        ctx.setLineDash([2, 3])
        for (const marker of markers) {
          const x = Math.round(marker.position * width) + 0.5
          ctx.beginPath()
          ctx.moveTo(x, 0)
          ctx.lineTo(x, height)
          ctx.stroke()
        }
        ctx.setLineDash([])
      }

      if (peaks) {
        const x = Math.round(progress * width) + 0.5
        ctx.strokeStyle = accent
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, height)
        ctx.stroke()
      }
    }

    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(container)
    return () => observer.disconnect()
  }, [peaks, progress, height, markers])

  const seekFromEvent = (clientX: number): void => {
    const container = containerRef.current
    if (!container || !onSeek) return
    const rect = container.getBoundingClientRect()
    onSeek(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)))
  }

  return (
    <div
      ref={containerRef}
      className={`relative w-full select-none ${onSeek ? 'cursor-pointer' : ''} ${className ?? ''}`}
      style={{ height }}
      onPointerDown={(event) => {
        if (!onSeek) return
        event.currentTarget.setPointerCapture(event.pointerId)
        seekFromEvent(event.clientX)
      }}
      onPointerMove={(event) => {
        if (!onSeek || event.buttons !== 1) return
        seekFromEvent(event.clientX)
      }}
      role={onSeek ? 'slider' : undefined}
      aria-label={onSeek ? 'Playback position' : undefined}
      aria-valuemin={onSeek ? 0 : undefined}
      aria-valuemax={onSeek ? 100 : undefined}
      aria-valuenow={onSeek ? Math.round(progress * 100) : undefined}
      tabIndex={onSeek ? 0 : undefined}
      onKeyDown={(event) => {
        if (!onSeek) return
        if (event.key === 'ArrowLeft') onSeek(Math.max(0, progress - 0.02))
        if (event.key === 'ArrowRight') onSeek(Math.min(1, progress + 0.02))
      }}
    >
      <canvas ref={canvasRef} className="block" />
    </div>
  )
}
