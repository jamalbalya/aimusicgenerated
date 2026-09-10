/**
 * Voice Changer — pitch and vocal-tract size, controlled separately.
 *
 * Shifting pitch alone gives you a chipmunk. Shifting the spectral envelope
 * with it is what actually changes who the voice sounds like, so both are
 * exposed, along with characters that set sensible pairs of both.
 */

import { useCallback, useState } from 'react'
import { Field, Panel, Progress, Segmented, Slider } from '../components/controls'
import { FileDrop } from '../components/FileDrop'
import { isCancellation, useJob } from '../useJob'
import { useStudio } from '../../state/store'
import { decodeAudioFile } from '../../lib/files'
import { formatDuration } from '../../engine/core/units'
import type { AudioData } from '../../engine/audio/wav'
import type { ProcessOp, ProcessResult } from '../../workers/protocol'

interface Character {
  id: string
  label: string
  blurb: string
  semitones: number
  formant: number
  extra?: ProcessOp[]
}

const CHARACTERS: Character[] = [
  { id: 'none', label: 'Unchanged', blurb: 'Original voice', semitones: 0, formant: 0 },
  { id: 'deeper', label: 'Deeper', blurb: 'Lower and larger', semitones: -4, formant: -3 },
  { id: 'giant', label: 'Giant', blurb: 'Very low, very large', semitones: -9, formant: -6, extra: [{ op: 'reverb', size: 0.8, damping: 0.5, mix: 0.25 }] },
  { id: 'higher', label: 'Higher', blurb: 'Lifted, still human', semitones: 4, formant: 2 },
  { id: 'chipmunk', label: 'Chipmunk', blurb: 'Small and fast', semitones: 9, formant: 7 },
  { id: 'feminine', label: 'Lighter', blurb: 'Higher pitch, shorter tract', semitones: 5, formant: 4 },
  { id: 'masculine', label: 'Fuller', blurb: 'Lower pitch, longer tract', semitones: -5, formant: -4 },
  { id: 'robot', label: 'Robot', blurb: 'Flattened and metallic', semitones: 0, formant: 0, extra: [{ op: 'chorus', depth: 1, mix: 0.8 }, { op: 'distortion', amount: 0.35 }] },
  { id: 'telephone', label: 'Telephone', blurb: 'Narrow band', semitones: 0, formant: 0, extra: [{ op: 'telephone' }] },
  { id: 'megaphone', label: 'Megaphone', blurb: 'Loud and distorted', semitones: 0, formant: 1, extra: [{ op: 'megaphone' }] },
  { id: 'ghost', label: 'Ghost', blurb: 'Detuned and distant', semitones: -2, formant: 3, extra: [{ op: 'reverb', size: 0.9, damping: 0.3, mix: 0.5 }, { op: 'echo', delaySeconds: 0.3, feedback: 0.35, mix: 0.3 }] },
]

export default function ShifterPage() {
  const job = useJob()
  const setCurrent = useStudio((s) => s.setCurrent)
  const notify = useStudio((s) => s.notify)

  const [file, setFile] = useState<{ name: string; size: number } | null>(null)
  const [source, setSource] = useState<AudioData | null>(null)
  const [character, setCharacter] = useState('deeper')
  const [semitones, setSemitones] = useState(-4)
  const [formant, setFormant] = useState(-3)
  const [mode, setMode] = useState<'natural' | 'tape'>('natural')
  const [tempo, setTempo] = useState(1)

  const load = useCallback(async (picked: File) => {
    try {
      const audio = await decodeAudioFile(picked)
      setSource(audio)
      setFile({ name: picked.name, size: picked.size })
      setCurrent({
        title: picked.name.replace(/\.[^.]+$/, ''),
        subtitle: 'Source',
        audio,
        source: 'edit',
      })
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not read that file.', 'error')
    }
  }, [notify, setCurrent])

  const applyCharacter = useCallback((id: string) => {
    setCharacter(id)
    const preset = CHARACTERS.find((c) => c.id === id)
    if (!preset) return
    setSemitones(preset.semitones)
    setFormant(preset.formant)
  }, [])

  const process = useCallback(async () => {
    if (!source) return
    const preset = CHARACTERS.find((c) => c.id === character)
    const ops: ProcessOp[] = []

    if (mode === 'tape') {
      const ratio = Math.pow(2, -semitones / 12)
      if (Math.abs(ratio - 1) > 1e-4) ops.push({ op: 'varispeed', ratio })
    } else {
      if (semitones !== 0 || formant !== 0) {
        ops.push({
          op: 'pitch',
          semitones,
          preserveFormants: true,
          formantSemitones: semitones + formant,
        })
      }
      if (Math.abs(tempo - 1) > 1e-3) ops.push({ op: 'tempo', ratio: 1 / tempo })
    }
    ops.push(...(preset?.extra ?? []))
    ops.push({ op: 'normalizePeak', targetDb: -1 })

    try {
      const output = await job.run<ProcessResult>('Transforming voice', {
        kind: 'process',
        audio: { channels: source.channels, sampleRate: source.sampleRate },
        ops,
      })
      setCurrent({
        title: `${file?.name.replace(/\.[^.]+$/, '') ?? 'Voice'} — ${preset?.label ?? 'Custom'}`,
        subtitle: `${semitones > 0 ? '+' : ''}${semitones} st · formant ${formant > 0 ? '+' : ''}${formant}`,
        audio: { channels: output.audio.channels, sampleRate: output.audio.sampleRate },
        source: 'edit',
      })
    } catch (error) {
      if (!isCancellation(error)) { /* reported by useJob */ }
    }
  }, [source, character, mode, semitones, formant, tempo, job, file, setCurrent])

  const duration = source ? (source.channels[0]?.length ?? 0) / source.sampleRate : 0

  return (
    <div className="grid gap-4">
      <header className="grid gap-2">
        <p className="t-label">Voice Changer</p>
        <h1 className="t-display max-w-2xl">Change the voice, not just the pitch.</h1>
        <p className="max-w-2xl text-[13.5px] leading-relaxed text-[var(--text-dim)]">
          Pitch and vocal-tract size are separate controls here, which is the difference between
          sounding like a different person and sounding like a sped-up tape.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <div className="grid content-start gap-4">
          <Panel title="Source">
            <FileDrop
              onFile={(picked) => void load(picked)}
              currentName={file?.name}
              currentSize={file?.size}
              disabled={job.running}
            />
            {source && (
              <p className="t-num mt-2.5 text-[11px] text-[var(--text-faint)]">
                {formatDuration(duration)} · {(source.sampleRate / 1000).toFixed(1)} kHz
              </p>
            )}
          </Panel>

          <Panel title="Characters">
            <div className="flex flex-wrap gap-1.5">
              {CHARACTERS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="chip"
                  title={option.blurb}
                  aria-pressed={character === option.id}
                  onClick={() => applyCharacter(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </Panel>
        </div>

        <Panel title="Controls">
          <div className="grid gap-4">
            <Field label="Mode" hint={mode === 'natural' ? 'Length is preserved and formants are controlled separately.' : 'Speed and pitch move together, like a tape machine.'}>
              <Segmented
                ariaLabel="Shift mode"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'natural', label: 'Natural' },
                  { value: 'tape', label: 'Tape' },
                ]}
              />
            </Field>

            <Field label="Pitch" value={`${semitones > 0 ? '+' : ''}${semitones} semitones`}>
              <Slider min={-12} max={12} value={semitones} onChange={setSemitones} ariaLabel="Pitch shift in semitones" />
            </Field>

            {mode === 'natural' && (
              <>
                <Field
                  label="Vocal tract"
                  value={`${formant > 0 ? '+' : ''}${formant}`}
                  hint="Negative sounds larger and deeper; positive sounds smaller and brighter."
                >
                  <Slider min={-8} max={8} value={formant} onChange={setFormant} ariaLabel="Formant shift" />
                </Field>

                <Field label="Speed" value={`${tempo.toFixed(2)}×`} hint="Changes length without touching pitch.">
                  <Slider min={0.5} max={2} step={0.05} value={tempo} onChange={setTempo} ariaLabel="Playback speed" />
                </Field>
              </>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!source || job.running}
                onClick={() => void process()}
              >
                {job.running ? 'Working…' : 'Apply'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={!source || job.running}
                onClick={() => {
                  if (!source) return
                  setCurrent({
                    title: file?.name.replace(/\.[^.]+$/, '') ?? 'Source',
                    subtitle: 'Source',
                    audio: source,
                    source: 'edit',
                  })
                }}
              >
                Back to original
              </button>
            </div>
            {job.running && <Progress value={job.progress} stage={job.stage} label="Transforming" />}
          </div>
        </Panel>
      </div>
    </div>
  )
}
