/**
 * Audio Toolkit — editing, effects and measurement in one place.
 */

import { useCallback, useState } from 'react'
import { Icon } from '../components/Icon'
import { Empty, Field, Panel, Progress, Slider, Stat } from '../components/controls'
import { FileDrop } from '../components/FileDrop'
import { Waveform } from '../components/Waveform'
import { isCancellation, useJob } from '../useJob'
import { useStudio } from '../../state/store'
import { decodeAudioFile } from '../../lib/files'
import { formatDuration } from '../../engine/core/units'
import { TOOLS } from '../nav'
import { linkProps } from '../../lib/router'
import type { AudioData } from '../../engine/audio/wav'
import type { AnalyzeResult, ProcessOp, ProcessResult } from '../../workers/protocol'

type Tab = 'edit' | 'effects' | 'analyse' | 'more'

export default function ToolkitPage() {
  const job = useJob()
  const setCurrent = useStudio((s) => s.setCurrent)
  const notify = useStudio((s) => s.notify)

  const [file, setFile] = useState<{ name: string; size: number } | null>(null)
  const [audio, setAudio] = useState<AudioData | null>(null)
  const [history, setHistory] = useState<AudioData[]>([])
  const [tab, setTab] = useState<Tab>('edit')
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null)

  // Edit controls
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)
  const [fadeIn, setFadeIn] = useState(0)
  const [fadeOut, setFadeOut] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [pitch, setPitch] = useState(0)

  // Effect controls
  const [reverbMix, setReverbMix] = useState(0.3)
  const [reverbSize, setReverbSize] = useState(0.6)
  const [echoMix, setEchoMix] = useState(0.3)
  const [echoTime, setEchoTime] = useState(0.35)
  const [drive, setDrive] = useState(0.3)
  const [low, setLow] = useState(0)
  const [mid, setMid] = useState(0)
  const [high, setHigh] = useState(0)
  const [denoise, setDenoise] = useState(0.6)

  const duration = audio ? (audio.channels[0]?.length ?? 0) / audio.sampleRate : 0

  const load = useCallback(async (picked: File) => {
    try {
      const decoded = await decodeAudioFile(picked)
      const seconds = (decoded.channels[0]?.length ?? 0) / decoded.sampleRate
      setAudio(decoded)
      setHistory([])
      setAnalysis(null)
      setFile({ name: picked.name, size: picked.size })
      setTrimStart(0)
      setTrimEnd(seconds)
      setCurrent({
        title: picked.name.replace(/\.[^.]+$/, ''),
        subtitle: `${formatDuration(seconds)} · ${(decoded.sampleRate / 1000).toFixed(1)} kHz`,
        audio: decoded,
        source: 'edit',
      })
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not read that file.', 'error')
    }
  }, [notify, setCurrent])

  const apply = useCallback(async (label: string, ops: ProcessOp[]) => {
    if (!audio || ops.length === 0) return
    try {
      const output = await job.run<ProcessResult>(label, {
        kind: 'process',
        audio: { channels: audio.channels, sampleRate: audio.sampleRate },
        ops,
      })
      const next: AudioData = { channels: output.audio.channels, sampleRate: output.audio.sampleRate }
      setHistory((past) => [...past, audio].slice(-8))
      setAudio(next)
      setAnalysis(null)
      const seconds = (next.channels[0]?.length ?? 0) / next.sampleRate
      setTrimStart(0)
      setTrimEnd(seconds)
      setCurrent({
        title: file?.name.replace(/\.[^.]+$/, '') ?? 'Edit',
        subtitle: `${label} · ${formatDuration(seconds)}`,
        audio: next,
        source: 'edit',
      })
      notify(`${label} applied.`, 'success')
    } catch (error) {
      if (!isCancellation(error)) { /* reported by useJob */ }
    }
  }, [audio, job, file, notify, setCurrent])

  const undo = useCallback(() => {
    setHistory((past) => {
      const previous = past[past.length - 1]
      if (!previous) return past
      setAudio(previous)
      setAnalysis(null)
      const seconds = (previous.channels[0]?.length ?? 0) / previous.sampleRate
      setTrimStart(0)
      setTrimEnd(seconds)
      setCurrent({
        title: file?.name.replace(/\.[^.]+$/, '') ?? 'Edit',
        subtitle: `Undone · ${formatDuration(seconds)}`,
        audio: previous,
        source: 'edit',
      })
      return past.slice(0, -1)
    })
  }, [file, setCurrent])

  const analyse = useCallback(async () => {
    if (!audio) return
    try {
      const output = await job.run<AnalyzeResult>('Analysing', {
        kind: 'analyze',
        audio: { channels: audio.channels, sampleRate: audio.sampleRate },
      })
      setAnalysis(output)
    } catch (error) {
      if (!isCancellation(error)) { /* reported by useJob */ }
    }
  }, [audio, job])

  return (
    <div className="grid gap-4">
      <header className="grid gap-2">
        <p className="t-label">Audio Toolkit</p>
        <h1 className="t-display max-w-2xl">Edit, treat and measure.</h1>
        <p className="max-w-2xl text-[13.5px] leading-relaxed text-[var(--text-dim)]">
          Everything you normally open a second app for: trimming, fades, speed and pitch,
          space and colour, noise reduction, and honest tempo, key and loudness readings.
        </p>
      </header>

      <Panel
        title="File"
        action={
          audio && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={history.length === 0 || job.running} onClick={undo}>
              Undo
            </button>
          )
        }
      >
        {audio ? (
          <div className="grid gap-3">
            <Waveform audio={audio} progress={0} height={72} />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Length" value={formatDuration(duration)} />
              <Stat label="Rate" value={`${(audio.sampleRate / 1000).toFixed(1)} kHz`} />
              <Stat label="Channels" value={audio.channels.length === 1 ? 'Mono' : 'Stereo'} />
              <Stat label="Edits" value={`${history.length}`} />
            </div>
            <FileDrop onFile={(picked) => void load(picked)} currentName={file?.name} currentSize={file?.size} disabled={job.running} />
          </div>
        ) : (
          <FileDrop onFile={(picked) => void load(picked)} disabled={job.running} />
        )}
        {job.running && <div className="mt-3"><Progress value={job.progress} stage={job.stage} label="Processing" /></div>}
      </Panel>

      <div className="segmented w-full sm:w-auto">
        {(['edit', 'effects', 'analyse', 'more'] as Tab[]).map((option) => (
          <button key={option} type="button" aria-pressed={tab === option} onClick={() => setTab(option)} className="flex-1 sm:flex-none">
            {option === 'edit' ? 'Edit' : option === 'effects' ? 'Effects' : option === 'analyse' ? 'Analyse' : 'More tools'}
          </button>
        ))}
      </div>

      {tab === 'edit' && (
        <Panel title="Edit">
          {audio ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-3.5">
                <Field label="Trim from" value={formatDuration(trimStart)}>
                  <Slider min={0} max={Math.max(0.1, duration)} step={0.1} value={trimStart} onChange={setTrimStart} ariaLabel="Trim start" />
                </Field>
                <Field label="Trim to" value={formatDuration(trimEnd)}>
                  <Slider min={0} max={Math.max(0.1, duration)} step={0.1} value={trimEnd} onChange={setTrimEnd} ariaLabel="Trim end" />
                </Field>
                <button
                  type="button"
                  className="btn"
                  disabled={job.running || trimEnd <= trimStart}
                  onClick={() => void apply('Trim', [{ op: 'trim', startSeconds: trimStart, endSeconds: trimEnd }])}
                >
                  Trim to selection
                </button>
              </div>

              <div className="grid gap-3.5">
                <Field label="Fade in" value={`${fadeIn.toFixed(1)}s`}>
                  <Slider min={0} max={10} step={0.1} value={fadeIn} onChange={setFadeIn} ariaLabel="Fade in seconds" />
                </Field>
                <Field label="Fade out" value={`${fadeOut.toFixed(1)}s`}>
                  <Slider min={0} max={10} step={0.1} value={fadeOut} onChange={setFadeOut} ariaLabel="Fade out seconds" />
                </Field>
                <button
                  type="button"
                  className="btn"
                  disabled={job.running || (fadeIn === 0 && fadeOut === 0)}
                  onClick={() => void apply('Fade', [{ op: 'fade', inSeconds: fadeIn, outSeconds: fadeOut }])}
                >
                  Apply fades
                </button>
              </div>

              <div className="grid gap-3.5">
                <Field label="Speed" value={`${speed.toFixed(2)}×`} hint="Pitch stays where it is.">
                  <Slider min={0.5} max={2} step={0.05} value={speed} onChange={setSpeed} ariaLabel="Speed" />
                </Field>
                <button
                  type="button"
                  className="btn"
                  disabled={job.running || Math.abs(speed - 1) < 1e-3}
                  onClick={() => void apply('Speed', [{ op: 'tempo', ratio: 1 / speed }])}
                >
                  Change speed
                </button>
              </div>

              <div className="grid gap-3.5">
                <Field label="Pitch" value={`${pitch > 0 ? '+' : ''}${pitch} st`} hint="Length stays where it is.">
                  <Slider min={-12} max={12} value={pitch} onChange={setPitch} ariaLabel="Pitch" />
                </Field>
                <button
                  type="button"
                  className="btn"
                  disabled={job.running || pitch === 0}
                  onClick={() => void apply('Pitch', [{ op: 'pitch', semitones: pitch, preserveFormants: false, formantSemitones: 0 }])}
                >
                  Change pitch
                </button>
              </div>

              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <button type="button" className="btn btn-sm" disabled={job.running} onClick={() => void apply('Reverse', [{ op: 'reverse' }])}>Reverse</button>
                <button type="button" className="btn btn-sm" disabled={job.running} onClick={() => void apply('Normalise', [{ op: 'normalize', targetLufs: -14 }])}>Normalise to −14 LUFS</button>
                <button type="button" className="btn btn-sm" disabled={job.running} onClick={() => void apply('Peak normalise', [{ op: 'normalizePeak', targetDb: -1 }])}>Peak to −1 dB</button>
                <button type="button" className="btn btn-sm" disabled={job.running} onClick={() => void apply('Limit', [{ op: 'limit', ceiling: 0.95 }])}>Limit</button>
              </div>
            </div>
          ) : (
            <Empty title="No file loaded" body="Drop an audio file above to start editing." />
          )}
        </Panel>
      )}

      {tab === 'effects' && (
        <Panel title="Effects">
          {audio ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-3.5">
                <Field label="Reverb size" value={`${Math.round(reverbSize * 100)}%`}>
                  <Slider min={0} max={1} step={0.05} value={reverbSize} onChange={setReverbSize} ariaLabel="Reverb size" />
                </Field>
                <Field label="Reverb mix" value={`${Math.round(reverbMix * 100)}%`}>
                  <Slider min={0} max={1} step={0.05} value={reverbMix} onChange={setReverbMix} ariaLabel="Reverb mix" />
                </Field>
                <button type="button" className="btn" disabled={job.running} onClick={() => void apply('Reverb', [{ op: 'reverb', size: reverbSize, damping: 0.4, mix: reverbMix }])}>
                  Add reverb
                </button>
              </div>

              <div className="grid gap-3.5">
                <Field label="Echo time" value={`${echoTime.toFixed(2)}s`}>
                  <Slider min={0.05} max={1.2} step={0.01} value={echoTime} onChange={setEchoTime} ariaLabel="Echo time" />
                </Field>
                <Field label="Echo mix" value={`${Math.round(echoMix * 100)}%`}>
                  <Slider min={0} max={1} step={0.05} value={echoMix} onChange={setEchoMix} ariaLabel="Echo mix" />
                </Field>
                <button type="button" className="btn" disabled={job.running} onClick={() => void apply('Echo', [{ op: 'echo', delaySeconds: echoTime, feedback: 0.4, mix: echoMix }])}>
                  Add echo
                </button>
              </div>

              <div className="grid gap-3.5 sm:col-span-2">
                <p className="t-label">Equaliser</p>
                <div className="grid gap-3.5 sm:grid-cols-3">
                  <Field label="Low" value={`${low > 0 ? '+' : ''}${low} dB`}>
                    <Slider min={-12} max={12} value={low} onChange={setLow} ariaLabel="Low shelf" />
                  </Field>
                  <Field label="Mid" value={`${mid > 0 ? '+' : ''}${mid} dB`}>
                    <Slider min={-12} max={12} value={mid} onChange={setMid} ariaLabel="Mid band" />
                  </Field>
                  <Field label="High" value={`${high > 0 ? '+' : ''}${high} dB`}>
                    <Slider min={-12} max={12} value={high} onChange={setHigh} ariaLabel="High shelf" />
                  </Field>
                </div>
                <button
                  type="button"
                  className="btn w-fit"
                  disabled={job.running || (low === 0 && mid === 0 && high === 0)}
                  onClick={() => void apply('EQ', [{ op: 'eq', lowDb: low, midDb: mid, highDb: high }])}
                >
                  Apply EQ
                </button>
              </div>

              <div className="grid gap-3.5">
                <Field label="Drive" value={`${Math.round(drive * 100)}%`}>
                  <Slider min={0} max={1} step={0.05} value={drive} onChange={setDrive} ariaLabel="Drive" />
                </Field>
                <button type="button" className="btn" disabled={job.running} onClick={() => void apply('Drive', [{ op: 'distortion', amount: drive }])}>
                  Add drive
                </button>
              </div>

              <div className="grid gap-3.5">
                <Field label="Noise reduction" value={`${Math.round(denoise * 100)}%`} hint="Learns the noise floor from the quietest moments and subtracts it.">
                  <Slider min={0} max={1} step={0.05} value={denoise} onChange={setDenoise} ariaLabel="Noise reduction" />
                </Field>
                <button type="button" className="btn" disabled={job.running} onClick={() => void apply('Noise reduction', [{ op: 'denoise', strength: denoise }])}>
                  Reduce noise
                </button>
              </div>

              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <button type="button" className="btn btn-sm" disabled={job.running} onClick={() => void apply('Telephone', [{ op: 'telephone' }])}>Telephone</button>
                <button type="button" className="btn btn-sm" disabled={job.running} onClick={() => void apply('Megaphone', [{ op: 'megaphone' }])}>Megaphone</button>
                <button type="button" className="btn btn-sm" disabled={job.running} onClick={() => void apply('Radio', [{ op: 'radio' }])}>Radio</button>
                <button type="button" className="btn btn-sm" disabled={job.running} onClick={() => void apply('Chorus', [{ op: 'chorus', depth: 0.6, mix: 0.4 }])}>Chorus</button>
                <button type="button" className="btn btn-sm" disabled={job.running} onClick={() => void apply('Compression', [{ op: 'compress', thresholdDb: -18, ratio: 3.5, makeupDb: 4 }])}>Compress</button>
              </div>
            </div>
          ) : (
            <Empty title="No file loaded" body="Drop an audio file above to treat it." />
          )}
        </Panel>
      )}

      {tab === 'analyse' && (
        <Panel
          title="Analysis"
          action={
            <button type="button" className="btn btn-sm" disabled={!audio || job.running} onClick={() => void analyse()}>
              {job.running ? 'Analysing…' : 'Analyse'}
            </button>
          }
        >
          {analysis ? (
            <div className="grid gap-5">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Tempo" value={`${analysis.tempo.bpm} BPM`} tone="accent" />
                <Stat label="Key" value={analysis.key.label} tone="accent" />
                <Stat label="Loudness" value={`${analysis.loudness.lufs.toFixed(1)} LUFS`} tone="signal" />
                <Stat label="True peak" value={`${analysis.loudness.peakDb.toFixed(1)} dB`} tone="signal" />
              </div>

              <div className="grid gap-2">
                <p className="t-label">Pitch content</p>
                <div className="flex h-24 items-end gap-1">
                  {analysis.key.chroma.map((value, index) => {
                    const max = Math.max(...analysis.key.chroma, 1e-6)
                    return (
                      <div key={index} className="flex flex-1 flex-col items-center gap-1">
                        <div
                          className="w-full rounded-t-[1px]"
                          style={{
                            height: `${Math.max(2, (value / max) * 76)}px`,
                            background: index === analysis.key.tonic ? 'var(--accent)' : 'var(--signal)',
                            opacity: index === analysis.key.tonic ? 1 : 0.55,
                          }}
                        />
                        <span className="t-num text-[9px] text-[var(--text-faint)]">
                          {['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][index]}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="grid gap-1.5 text-[12.5px] text-[var(--text-dim)]">
                <p>
                  Tempo confidence {Math.round(analysis.tempo.confidence * 100)}% ·
                  key confidence {Math.round(analysis.key.confidence * 100)}%.
                </p>
                {analysis.loudness.clipping && (
                  <p className="text-[var(--danger)]">
                    This file already clips. Peak-normalise to −1 dB before doing anything else to it.
                  </p>
                )}
                <p>
                  Streaming services target about −14 LUFS. This file is{' '}
                  {analysis.loudness.lufs < -16 ? 'quieter than' : analysis.loudness.lufs > -12 ? 'louder than' : 'close to'} that.
                </p>
              </div>
            </div>
          ) : (
            <Empty
              title={audio ? 'Not analysed yet' : 'No file loaded'}
              body={audio ? 'Press Analyse to read the tempo, key and loudness.' : 'Drop an audio file above first.'}
            />
          )}
        </Panel>
      )}

      {tab === 'more' && (
        <Panel title="Every tool">
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {TOOLS.map((tool) => (
              <li key={tool.path}>
                <a className="panel-sunken flex items-start gap-3 p-3 transition-colors hover:border-[var(--line-strong)]" {...linkProps(tool.path)}>
                  <Icon name={tool.icon} size={17} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                  <span className="grid gap-0.5">
                    <span className="text-[13px] font-medium">{tool.label}</span>
                    <span className="text-[11.5px] leading-snug text-[var(--text-dim)]">{tool.blurb}</span>
                  </span>
                </a>
              </li>
            ))}
            <li>
              <a className="panel-sunken flex items-start gap-3 p-3 transition-colors hover:border-[var(--line-strong)]" {...linkProps('/about')}>
                <Icon name="info" size={17} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                <span className="grid gap-0.5">
                  <span className="text-[13px] font-medium">How this works</span>
                  <span className="text-[11.5px] leading-snug text-[var(--text-dim)]">What the engine actually does, and what it does not.</span>
                </span>
              </a>
            </li>
          </ul>
        </Panel>
      )}
    </div>
  )
}
