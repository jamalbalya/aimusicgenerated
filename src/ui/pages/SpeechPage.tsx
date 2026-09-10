/**
 * Text to Speech.
 *
 * Two engines are offered. The built-in one is a formant synthesiser that runs
 * here and can be exported to a file. The browser's own voices usually sound
 * more natural but cannot be captured to a file in most browsers, so they are
 * offered for preview only, and the difference is stated plainly rather than
 * hidden behind a "download" button that quietly fails.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Empty, Field, Panel, Progress, Segmented, Slider } from '../components/controls'
import { isCancellation, useJob } from '../useJob'
import { useStudio } from '../../state/store'
import { SPEECH_VOICES } from '../../engine/voice/speech'
import { detectLanguage, LANGUAGE_CHOICES, languageProfile, type LanguageId } from '../../engine/lang'
import { formatDuration } from '../../engine/core/units'
import type { ProcessOp, SpeakResult } from '../../workers/protocol'

type EffectPreset = 'none' | 'telephone' | 'megaphone' | 'radio' | 'hall' | 'robot' | 'deep' | 'chipmunk'

const EFFECTS: { id: EffectPreset; label: string; ops: ProcessOp[] }[] = [
  { id: 'none', label: 'Clean', ops: [] },
  { id: 'hall', label: 'Hall', ops: [{ op: 'reverb', size: 0.75, damping: 0.35, mix: 0.32 }] },
  { id: 'telephone', label: 'Telephone', ops: [{ op: 'telephone' }] },
  { id: 'megaphone', label: 'Megaphone', ops: [{ op: 'megaphone' }] },
  { id: 'radio', label: 'Radio', ops: [{ op: 'radio' }] },
  { id: 'robot', label: 'Robot', ops: [{ op: 'chorus', depth: 1, mix: 0.7 }, { op: 'distortion', amount: 0.3 }] },
  { id: 'deep', label: 'Deeper', ops: [{ op: 'pitch', semitones: -4, preserveFormants: false, formantSemitones: -2 }] },
  { id: 'chipmunk', label: 'Higher', ops: [{ op: 'pitch', semitones: 5, preserveFormants: false, formantSemitones: 2 }] },
]

const SAMPLE_TEXT = 'Everything here runs on your device. No account, no subscription, no limits.'

export default function SpeechPage() {
  const job = useJob()
  const setCurrent = useStudio((s) => s.setCurrent)
  const notify = useStudio((s) => s.notify)

  const [text, setText] = useState(SAMPLE_TEXT)
  const [voiceId, setVoiceId] = useState(SPEECH_VOICES[2]!.id)
  const [speed, setSpeed] = useState(1)
  const [pitch, setPitch] = useState(0)
  const [expressiveness, setExpressiveness] = useState(1)
  const [effect, setEffect] = useState<EffectPreset>('none')
  const [engine, setEngine] = useState<'builtin' | 'browser'>('builtin')
  const [language, setLanguage] = useState<LanguageId | 'auto'>('auto')

  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([])
  const [browserVoiceName, setBrowserVoiceName] = useState('')
  const [browserSpeaking, setBrowserSpeaking] = useState(false)

  // Shown beside the automatic option so the reading is visible before it plays.
  const detectedName = useMemo(() => {
    if (!text.trim()) return undefined
    return LANGUAGE_CHOICES.find((choice) => choice.id === detectLanguage(text))?.label
  }, [text])

  const voice = useMemo(
    () => SPEECH_VOICES.find((v) => v.id === voiceId) ?? SPEECH_VOICES[0]!,
    [voiceId],
  )

  /**
   * System voices, with the ones that speak the text's own language first.
   *
   * A browser typically offers dozens; leaving an Indonesian line to be read by
   * whichever voice happens to be first in the list is the difference between
   * something usable and something comic.
   */
  const sortedBrowserVoices = useMemo(() => {
    const detected = language === 'auto' ? detectLanguage(text) : language
    const tags = languageProfile(detected).voiceTags.map((tag) => tag.toLowerCase())
    if (tags.length === 0) return browserVoices
    const rank = (voice: SpeechSynthesisVoice): number => {
      const lang = voice.lang.toLowerCase().replace('_', '-')
      const index = tags.findIndex((tag) => lang === tag || lang.startsWith(`${tag}-`))
      return index === -1 ? tags.length : index
    }
    return browserVoices.slice().sort((a, b) => rank(a) - rank(b))
  }, [browserVoices, language, text])

  const hasBrowserSpeech = typeof window !== 'undefined' && 'speechSynthesis' in window

  useEffect(() => {
    if (!hasBrowserSpeech) return
    const load = (): void => {
      const voices = window.speechSynthesis.getVoices()
      setBrowserVoices(voices)
      setBrowserVoiceName((current) => current || voices.find((v) => v.default)?.name || voices[0]?.name || '')
    }
    load()
    window.speechSynthesis.addEventListener('voiceschanged', load)
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', load)
      window.speechSynthesis.cancel()
    }
  }, [hasBrowserSpeech])

  const speak = useCallback(async () => {
    const value = text.trim()
    if (!value) {
      notify('Type something to say.', 'error')
      return
    }
    try {
      const ops = EFFECTS.find((e) => e.id === effect)?.ops ?? []
      const output = await job.run<SpeakResult>('Synthesising speech', {
        kind: 'speak',
        text: value,
        voice,
        options: { speed, pitchSemitones: pitch, expressiveness, sampleRate: 44100, seed: value, language },
        ops,
      })
      setCurrent({
        title: firstWords(value),
        subtitle: `${voice.label} · ${EFFECTS.find((e) => e.id === effect)?.label ?? 'Clean'}`,
        audio: { channels: output.audio.channels, sampleRate: output.audio.sampleRate },
        source: 'speech',
      })
    } catch (error) {
      if (!isCancellation(error)) { /* reported by useJob */ }
    }
  }, [text, voice, speed, pitch, expressiveness, effect, language, job, notify, setCurrent])

  const speakInBrowser = useCallback(() => {
    if (!hasBrowserSpeech) return
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    const selected = browserVoices.find((v) => v.name === browserVoiceName)
    if (selected) utterance.voice = selected
    utterance.rate = speed
    utterance.pitch = Math.max(0, Math.min(2, 1 + pitch / 12))
    utterance.onend = () => setBrowserSpeaking(false)
    utterance.onerror = () => setBrowserSpeaking(false)
    setBrowserSpeaking(true)
    window.speechSynthesis.speak(utterance)
  }, [hasBrowserSpeech, text, browserVoices, browserVoiceName, speed, pitch])

  const estimatedSeconds = useMemo(() => {
    const words = text.trim().split(/\s+/).filter(Boolean).length
    return words > 0 ? (words / (voice.rate * speed)) * 60 : 0
  }, [text, voice, speed])

  return (
    <div className="grid gap-4">
      <header className="grid gap-2">
        <p className="t-label">Text to Speech</p>
        <h1 className="t-display max-w-2xl">Eight voices, no character limit.</h1>
        <p className="max-w-2xl text-[13.5px] leading-relaxed text-[var(--text-dim)]">
          The built-in synthesiser models a vocal tract directly, so it works offline and every
          result can be downloaded as a file.
        </p>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,330px)]">
        <Panel title="Script">
          <div className="grid gap-3">
            <textarea
              className="textarea !min-h-[220px]"
              value={text}
              aria-label="Text to speak"
              placeholder="Type or paste anything…"
              onChange={(event) => setText(event.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              {engine === 'builtin' ? (
                <button type="button" className="btn btn-primary" disabled={job.running} onClick={() => void speak()}>
                  {job.running ? 'Synthesising…' : 'Speak & load'}
                </button>
              ) : (
                <>
                  <button type="button" className="btn btn-primary" onClick={speakInBrowser} disabled={!hasBrowserSpeech}>
                    {browserSpeaking ? 'Speaking…' : 'Preview'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!browserSpeaking}
                    onClick={() => {
                      window.speechSynthesis.cancel()
                      setBrowserSpeaking(false)
                    }}
                  >
                    Stop
                  </button>
                </>
              )}
              <span className="t-num ml-auto text-[11px] text-[var(--text-faint)]">
                {text.trim().split(/\s+/).filter(Boolean).length} words · ≈{formatDuration(estimatedSeconds)}
              </span>
            </div>
            {job.running && <Progress value={job.progress} stage={job.stage} label="Synthesising" />}
          </div>
        </Panel>

        <div className="grid content-start gap-4">
          <Panel title="Engine">
            <div className="grid gap-3">
              <Segmented
                ariaLabel="Speech engine"
                value={engine}
                onChange={setEngine}
                options={[
                  { value: 'builtin', label: 'Built-in', title: 'Runs here, exports to a file' },
                  { value: 'browser', label: 'System voices', title: 'Preview only — cannot be exported' },
                ]}
              />
              <p className="text-[11.5px] leading-snug text-[var(--text-faint)]">
                {engine === 'builtin'
                  ? 'Renders to audio you can play, edit and download.'
                  : 'Uses the voices installed on this device. They usually sound more natural, but browsers do not let a page record them, so this mode is preview only.'}
              </p>
            </div>
          </Panel>

          <Panel title="Delivery">
            <div className="grid gap-3.5">
              {engine === 'builtin' ? (
                <Field label="Voice">
                  <select className="select" value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
                    {SPEECH_VOICES.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </Field>
              ) : (
                <Field label="System voice">
                  {sortedBrowserVoices.length > 0 ? (
                    <select
                      className="select"
                      value={browserVoiceName}
                      onChange={(e) => setBrowserVoiceName(e.target.value)}
                    >
                      {sortedBrowserVoices.map((option) => (
                        <option key={`${option.name}-${option.lang}`} value={option.name}>
                          {option.name} · {option.lang}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-[12px] text-[var(--text-faint)]">
                      No system voices are available in this browser.
                    </p>
                  )}
                </Field>
              )}

              {engine === 'builtin' && (
                <Field
                  label="Language"
                  htmlFor="speech-language"
                  value={language === 'auto' ? detectedName : undefined}
                  hint="Sets which sounds the letters stand for, so a name or a line in another language is not read as English."
                >
                  <select
                    id="speech-language"
                    className="select"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value as LanguageId | 'auto')}
                  >
                    {LANGUAGE_CHOICES.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.id === 'auto' ? choice.label : `${choice.label} — ${choice.native}`}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              <Field label="Speed" value={`${speed.toFixed(2)}×`}>
                <Slider min={0.5} max={2} step={0.05} value={speed} onChange={setSpeed} ariaLabel="Speaking speed" />
              </Field>

              <Field label="Pitch" value={`${pitch > 0 ? '+' : ''}${pitch} st`}>
                <Slider min={-12} max={12} value={pitch} onChange={setPitch} ariaLabel="Pitch in semitones" />
              </Field>

              {engine === 'builtin' && (
                <>
                  <Field label="Expression" value={expressiveness === 0 ? 'Monotone' : `${expressiveness.toFixed(1)}×`}>
                    <Slider min={0} max={2} step={0.1} value={expressiveness} onChange={setExpressiveness} ariaLabel="Expressiveness" />
                  </Field>

                  <Field label="Effect">
                    <div className="flex flex-wrap gap-1.5">
                      {EFFECTS.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className="chip"
                          aria-pressed={effect === option.id}
                          onClick={() => setEffect(option.id)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </Field>
                </>
              )}
            </div>
          </Panel>

          {!hasBrowserSpeech && engine === 'browser' && (
            <Panel>
              <Empty
                title="No system voices here"
                body="This browser does not expose speech synthesis. Switch back to the built-in engine, which works everywhere."
              />
            </Panel>
          )}
        </div>
      </div>
    </div>
  )
}

function firstWords(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 6).join(' ')
  return words.length > 48 ? `${words.slice(0, 48)}…` : words || 'Speech'
}
