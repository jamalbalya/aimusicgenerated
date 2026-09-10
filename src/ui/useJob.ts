/** Runs a worker job while keeping the global progress bar in sync. */

import { useCallback, useEffect, useRef, useState } from 'react'
import { runJob } from '../workers/client'
import type { WorkerRequest, WorkerResult } from '../workers/protocol'
import { useStudio } from '../state/store'

export interface JobRunner {
  running: boolean
  progress: number
  stage: string
  run: <T extends WorkerResult>(label: string, request: WorkerRequest) => Promise<T>
  cancel: () => void
}

export function useJob(): JobRunner {
  const setJob = useStudio((s) => s.setJob)
  const notify = useStudio((s) => s.notify)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
      setJob(null)
    }
  }, [setJob])

  const run = useCallback(async <T extends WorkerResult>(label: string, request: WorkerRequest): Promise<T> => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller

    setRunning(true)
    setProgress(0)
    setStage('')
    setJob({ label, progress: 0, stage: '' })

    try {
      return await runJob<T>(request, {
        signal: controller.signal,
        onProgress: (value, currentStage) => {
          if (!mountedRef.current) return
          setProgress(value)
          setStage(currentStage)
          setJob({ label, progress: value, stage: currentStage })
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A cancellation is a user action, not a failure worth shouting about.
      if (message !== 'Cancelled') notify(message, 'error')
      throw error
    } finally {
      if (mountedRef.current) {
        setRunning(false)
        setProgress(0)
        setStage('')
      }
      setJob(null)
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [notify, setJob])

  const cancel = useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
    setRunning(false)
    setJob(null)
  }, [setJob])

  return { running, progress, stage, run, cancel }
}

/** True when the error was the user cancelling, which callers should ignore. */
export function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.message === 'Cancelled'
}
