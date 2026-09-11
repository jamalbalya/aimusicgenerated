/** Form primitives shared by every tool page. */

import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'

interface FieldProps {
  label: string
  hint?: string
  /** Right-aligned readout, usually the current value. */
  value?: ReactNode
  children: ReactNode
  /** Only needed when the control is not a direct child of the field. */
  htmlFor?: string
  /** A control on the label's own row, for a switch that belongs to the field. */
  action?: ReactNode
}

interface SliderProps {
  id?: string
  min: number
  max: number
  step?: number
  value: number
  onChange: (value: number) => void
  disabled?: boolean
  ariaLabel?: string
}

export function Slider({ id, min, max, step = 1, value, onChange, disabled, ariaLabel }: SliderProps) {
  return (
    <input
      id={id}
      type="range"
      className="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  )
}

const NATIVE_CONTROLS = new Set(['input', 'select', 'textarea'])

/**
 * A labelled control.
 *
 * When the child is a single form control the label is wired to it
 * automatically — leaving that to each call site is exactly how form labels
 * end up unassociated, which breaks screen readers and every accessible
 * selector along with them.
 */
export function Field({ label, hint, value, children, htmlFor, action }: FieldProps) {
  const generatedId = useId()

  let content = children
  let controlId = htmlFor

  if (!controlId && isValidElement(children)) {
    const element = children as ReactElement<{ id?: string }>
    const isNative = typeof element.type === 'string' && NATIVE_CONTROLS.has(element.type)
    if (isNative || element.type === Slider) {
      controlId = element.props.id ?? generatedId
      content = cloneElement(element, { id: controlId })
    }
  }

  return (
    <div className="grid gap-1.5">
      <div className="flex min-h-[20px] items-center justify-between gap-3">
        <label className="t-label" htmlFor={controlId}>{label}</label>
        {action ?? (value !== undefined && (
          <span className="t-num text-[11px] text-[var(--text-dim)]">{value}</span>
        ))}
      </div>
      {content}
      {hint && <p className="text-[11.5px] leading-snug text-[var(--text-faint)]">{hint}</p>}
    </div>
  )
}

/**
 * An on/off switch.
 *
 * A checkbox says "tick this to include it"; a switch says "this is on or off
 * right now", which is what a setting like Instrumental actually is. It is a
 * real checkbox underneath so it keeps every keyboard and screen-reader
 * behaviour a checkbox has.
 */
export function Toggle(
  { label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void },
) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-[11.5px] text-[var(--text-dim)]">
      {label}
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {/*
        The track and knob take their state from React rather than from
        `peer-checked:`, because the knob is a descendant of the track and a
        peer variant only ever reaches the input's own siblings. The focus ring
        is the one thing that does belong to the track itself.
      */}
      <span
        aria-hidden="true"
        className={`relative h-[18px] w-[32px] rounded-full border transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--accent)] ${
          checked
            ? 'border-[var(--accent)] bg-[var(--accent)]'
            : 'border-[var(--line)] bg-[var(--bg-sunken)]'
        }`}
      >
        <span
          className={`absolute left-[2px] top-[2px] h-[12px] w-[12px] rounded-full transition-transform ${
            checked ? 'translate-x-[14px] bg-white' : 'bg-[var(--text-dim)]'
          }`}
        />
      </span>
    </label>
  )
}

interface SegmentedProps<T extends string> {
  options: { value: T; label: string; title?: string }[]
  value: T
  onChange: (value: T) => void
  ariaLabel: string
  /** Shows the current choice but refuses a new one. The field's hint says why. */
  disabled?: boolean
}

export function Segmented<T extends string>({
  options, value, onChange, ariaLabel, disabled,
}: SegmentedProps<T>) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Panel({ title, action, children, className }: {
  title?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`panel ${className ?? ''}`}>
      {(title || action) && (
        <header className="flex min-h-[38px] items-center justify-between gap-3 border-b border-[var(--line)] px-3.5 py-2">
          {title && <h2 className="t-label">{title}</h2>}
          {action}
        </header>
      )}
      <div className="p-3.5">{children}</div>
    </section>
  )
}

export function Progress({ value, stage, label }: { value: number; stage?: string; label?: string }) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100)
  const indeterminate = value <= 0
  return (
    <div className="grid gap-1.5" role="status" aria-live="polite">
      <div className="flex items-baseline justify-between gap-3">
        <span className="t-label">{label ?? 'Working'}</span>
        <span className="t-num text-[11px] text-[var(--text-dim)]">
          {stage ? `${stage} · ` : ''}{indeterminate ? '' : `${percent}%`}
        </span>
      </div>
      <div className={`meter-track ${indeterminate ? 'sweep' : ''}`}>
        {!indeterminate && <div className="meter-fill" style={{ width: `${percent}%` }} />}
      </div>
    </div>
  )
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="grid place-items-center gap-1.5 px-4 py-7 text-center">
      <p className="t-title">{title}</p>
      <p className="max-w-[46ch] text-[13px] leading-relaxed text-[var(--text-dim)]">{body}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'accent' | 'signal' }) {
  const color = tone === 'accent' ? 'text-[var(--accent)]' : tone === 'signal' ? 'text-[var(--signal)]' : ''
  return (
    <div className="grid gap-1">
      <span className="t-label">{label}</span>
      <span className={`t-num text-[15px] leading-none ${color}`}>{value}</span>
    </div>
  )
}
