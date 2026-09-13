/**
 * What is left of the free GPU allowance, when Hugging Face has said.
 *
 * Informational only. The Space verifies every request and enforces its own
 * limits; nothing here is consulted before a generation, and hiding this banner
 * changes nothing about what is allowed.
 *
 * It is honest about what it does not know, which is most of it most of the
 * time: Hugging Face publishes no allowance endpoint, so until a request is
 * actually refused there is no number to show, and the banner says that rather
 * than inventing one.
 */

import { useState } from 'react'

import {
  formatCountdown, quotaSeverity, usagePercentage,
} from '../../engine/providers/zeroGpuQuota'
import { Icon } from './Icon'
import { useCountdown, useZeroGpuQuota } from '../useZeroGpuQuota'

/** Whole seconds, written the way the rest of the interface writes them. */
function secondsLabel(value: number | null): string {
  if (value === null) return 'unknown'
  return `${Math.round(value)} seconds`
}

export default function ZeroGpuQuotaBanner() {
  // In memory, and nowhere else. Closing it is for this view of this page: a
  // reload, a new tab, or signing out and back in all bring it back, because
  // the allowance is the kind of thing worth being reminded about.
  const [visible, setVisible] = useState(true)
  const quota = useZeroGpuQuota()
  const countdown = useCountdown(quota.retryAt)

  if (!visible) return null

  const severity = quotaSeverity(quota)
  const percent = usagePercentage(quota)
  const known = quota.source !== 'unknown'

  const tone = severity === 'exhausted' ? 'var(--danger)'
    : severity === 'low' ? 'var(--warn, #e9a13b)'
      : 'var(--line)'

  // The wait is over once the countdown reaches zero. Said in those words,
  // because "0s" reads like a clock that has stopped rather than an allowance
  // that is back.
  const waiting = countdown !== null && countdown > 0
  const showWait = quota.retryAt !== null

  return (
    <section
      data-testid="zerogpu-quota-banner"
      // Named, but not a heading. Every page in this application uses level-2
      // headings for generated songs, and a banner that sits above all of them
      // would put a permanent entry at the top of that outline — telling a
      // screen reader there is a result when there is not, and breaking the
      // reading order of the page it is only annotating.
      aria-label="ZeroGPU quota"
      className="mb-4 rounded-[10px] border bg-[var(--bg-panel)] px-3.5 py-3"
      style={{ borderColor: tone }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <p className="t-label">ZeroGPU quota</p>
            <span
              className="t-num text-[11px] text-[var(--text-dim)]"
              data-testid="zerogpu-quota-status"
            >
              {known ? 'Last known value, from Hugging Face' : 'Live quota information is unavailable'}
            </span>
          </div>

          {known ? (
            <>
              <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-0.5 text-[12.5px]">
                <div className="flex gap-1.5">
                  <dt className="text-[var(--text-dim)]">Remaining:</dt>
                  <dd className="t-num" data-testid="quota-remaining">
                    {secondsLabel(quota.remainingSeconds)}
                  </dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-[var(--text-dim)]">Used:</dt>
                  <dd className="t-num" data-testid="quota-used">
                    {quota.usedSeconds === null ? 'not published' : secondsLabel(quota.usedSeconds)}
                  </dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-[var(--text-dim)]">Daily limit:</dt>
                  <dd className="t-num" data-testid="quota-total">
                    {quota.totalSeconds === null ? 'not published' : secondsLabel(quota.totalSeconds)}
                  </dd>
                </div>
                {showWait && (
                  <div className="flex gap-1.5">
                    <dt className="text-[var(--text-dim)]">
                      {waiting ? 'Resets in:' : 'Status:'}
                    </dt>
                    <dd className="t-num" data-testid="quota-countdown">
                      {waiting ? formatCountdown(countdown) : 'Quota reset available'}
                    </dd>
                  </div>
                )}
              </dl>

              {/* Only drawn when the total is known, because a bar without one
                  would be a picture of a number nobody has. */}
              {percent !== null && (
                <div className="meter-track mt-2" role="img"
                     aria-label={`${Math.round(percent)}% of the daily allowance used`}>
                  <div className="meter-fill" style={{ width: `${Math.round(percent)}%` }} />
                </div>
              )}

              <p className="mt-1.5 text-[11.5px] leading-snug text-[var(--text-dim)]">
                {severity === 'exhausted'
                  ? 'The allowance is spent. Offline Procedural Mode still works and costs nothing.'
                  : showWait && !waiting
                    ? 'The wait is over. There is no endpoint to re-read, so the next generation '
                      + 'is what will report the current figure.'
                    : 'Hugging Face publishes no allowance endpoint, so this is the figure from the last '
                      + 'refusal rather than a live reading. The Space decides what is allowed.'}
              </p>
            </>
          ) : (
            <p className="mt-1 text-[12px] leading-snug text-[var(--text-dim)]">
              Hugging Face does not publish a way to read the free GPU allowance, and a successful
              generation does not report one. A figure appears here only if a request is refused for
              running out.
            </p>
          )}
        </div>

        <button
          type="button"
          className="btn btn-ghost btn-sm shrink-0 !px-2"
          aria-label="Dismiss the ZeroGPU quota banner"
          data-testid="zerogpu-quota-dismiss"
          onClick={() => setVisible(false)}
        >
          <Icon name="close" size={15} />
        </button>
      </div>
    </section>
  )
}
