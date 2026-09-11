/**
 * How this works — an honest account of the engine, including its limits.
 */

import { Panel } from '../components/controls'
import { Icon } from '../components/Icon'
import { TOOLS } from '../nav'
import { linkProps } from '../../lib/router'
import { GENRES } from '../../engine/compose/genres'
import { SPEECH_VOICES } from '../../engine/voice/speech'
import { SING_PRESET_NAMES } from '../../engine/voice/singer'
import { PROGRESSIONS } from '../../engine/theory/progressions'

export default function AboutPage() {
  return (
    <div className="grid gap-4">
      <header className="grid gap-2">
        <p className="t-label">How this works</p>
        <h1 className="t-display max-w-2xl">Everything runs here. That is why it is free.</h1>
        <p className="max-w-2xl text-[13.5px] leading-relaxed text-[var(--text-dim)]">
          There is no server doing the work, so there is no bill to pass on to you, no queue,
          no daily quota and no account. Close the tab and nothing about your session survives
          except what you saved to this device.
        </p>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <Panel title="What you get">
          <ul className="grid gap-2.5 text-[13px] leading-relaxed">
            {[
              'Unlimited generations, every day',
              'No watermark on anything',
              'Full-quality WAV and MP3 export',
              'Every instrument as a separate stem',
              'Commercial use — it is your audio',
              'Works offline once loaded',
              'Nothing uploaded, ever',
              'Covers: swap the voice on a finished song',
              'Ships as one file you can keep',
            ].map((item) => (
              <li key={item} className="flex items-start gap-2">
                <Icon name="check" size={14} className="mt-0.5 shrink-0 text-[var(--ok)]" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="By the numbers">
          <dl className="grid gap-3">
            {[
              ['Genres', `${GENRES.length}`],
              ['Chord progressions', `${PROGRESSIONS.length}`],
              ['Instruments', '31 synthesised'],
              ['Drum pieces', '20 synthesised'],
              ['Singing voices', `${SING_PRESET_NAMES.length}`],
              ['Speaking voices', `${SPEECH_VOICES.length}`],
              ['Tools', `${TOOLS.length}`],
            ].map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-3 border-b border-[var(--line)] pb-2 last:border-0 last:pb-0">
                <dt className="t-label">{label}</dt>
                <dd className="t-num text-[14px]">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>

        <Panel title="Tools">
          <ul className="grid gap-2">
            {TOOLS.map((tool) => (
              <li key={tool.path}>
                <a className="flex items-start gap-2.5 text-[13px] hover:text-[var(--accent)]" {...linkProps(tool.path)}>
                  <Icon name={tool.icon} size={15} className="mt-0.5 shrink-0 text-[var(--text-faint)]" />
                  <span>
                    <span className="font-medium">{tool.label}</span>
                    <span className="block text-[11.5px] leading-snug text-[var(--text-dim)]">{tool.blurb}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel title="Under the hood">
        <div className="grid gap-5 text-[13px] leading-relaxed sm:grid-cols-2">
          <section className="grid gap-1.5">
            <h3 className="t-title text-[14px]">Composition</h3>
            <p className="text-[var(--text-dim)]">
              Your description is matched against genre and mood vocabularies to pick a tempo,
              a key and a harmonic language. The arranger builds a form that fits the length you
              asked for, harmony is drawn from a library of progressions transposed into the key,
              and melodies are built from short motifs that are repeated and transformed —
              inverted, transposed, retrograded — so the tune develops instead of wandering.
              Strong beats land on chord tones. The same seed always gives the same song.
            </p>
          </section>

          <section className="grid gap-1.5">
            <h3 className="t-title text-[14px]">Sound</h3>
            <p className="text-[var(--text-dim)]">
              Nothing is sampled. Each instrument is a synthesis model — subtractive, FM,
              additive, or a plucked-string delay line — and the drums are oscillators and
              filtered noise. The mix runs a real signal chain: per-track EQ and saturation,
              kick-triggered ducking, a shared reverb and ping-pong delay, bus compression and a
              look-ahead limiter.
            </p>
          </section>

          <section className="grid gap-1.5">
            <h3 className="t-title text-[14px]">Voice</h3>
            <p className="text-[var(--text-dim)]">
              Words are converted to phonemes by rule, then sung through a source-filter model:
              a glottal pulse with vibrato, jitter and breath, shaped by band-pass filters set to
              the formants of each vowel, gliding between them the way a real tract does.
              Consonants are rendered as stops, fricatives and nasal resonances between them.
            </p>
          </section>

          <section className="grid gap-1.5">
            <h3 className="t-title text-[14px]">Separation</h3>
            <p className="text-[var(--text-dim)]">
              Stems come from two classical signal-processing facts: sustained tones form
              horizontal ridges in a spectrogram while transients form vertical ones, and lead
              vocals sit in the centre of a stereo image. Median filtering along each axis
              separates harmonic from percussive; comparing the two channels finds what is
              centred. The masks are soft, which avoids the underwater artefacts you get from
              hard cut-offs.
            </p>
          </section>
        </div>
      </Panel>

      <Panel title="What this is not">
        <div className="grid gap-2.5 text-[13px] leading-relaxed text-[var(--text-dim)]">
          <p>
            The offline engine is not a large neural model. Those need a data centre with GPUs,
            which is exactly the cost that paid services are charging you for. What it is instead
            is a composition and synthesis engine that is genuinely unlimited, genuinely private,
            and genuinely free — with the trade-off that it sounds like a very good software
            instrument rather than a recording of a band.
          </p>
          <p>
            The Song Studio's Neural mode is the other way round. It sends your style and lyrics to
            the ACE-Step 1.5 model — on the public site, running on a free Hugging Face ZeroGPU
            Space — which returns one complete song with a sung vocal. It needs a connection, the
            free GPU comes with a daily allowance per visitor, and the Studio always says which
            engine made a song.
          </p>
          <p>
            Separation is likewise signal processing rather than a trained model, so a vocal that
            is heavily doubled, hard-panned or drenched in reverb will not come out as cleanly as
            it would from a model trained on thousands of songs. On ordinary stereo mixes it does
            well.
          </p>
          <p>
            The system voices in Text to Speech belong to your operating system. Browsers do not
            let a web page record them, so those are preview-only; the built-in engine is the one
            that exports.
          </p>
        </div>
      </Panel>

      <Panel title="Performance">
        <div className="grid gap-2.5 text-[13px] leading-relaxed text-[var(--text-dim)]">
          <p>
            Rendering happens on a background thread, so the interface stays responsive, but a
            long song at studio quality is real work for a phone. If generation feels slow, drop
            the render quality in the sidebar — <span className="t-num">Draft</span> is roughly
            twice as fast as <span className="t-num">Studio</span> and is fine for auditioning
            ideas. Re-render at studio quality once you like the result.
          </p>
          <p>
            Separation and pitch shifting scale with the length of the file. A three-minute track
            is comfortable; if you only need part of it, trim it first in the Audio Toolkit.
          </p>
        </div>
      </Panel>

      <p className="text-[11.5px] leading-relaxed text-[var(--text-faint)]">
        Resonant Studio is open source and MIT licensed. Audio you generate is yours, with no
        conditions attached.
      </p>
    </div>
  )
}
