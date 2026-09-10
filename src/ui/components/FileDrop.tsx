/** Drop zone and file picker for audio uploads. */

import { useCallback, useRef, useState } from 'react'
import { Icon } from './Icon'
import { formatBytes } from '../../lib/files'

interface FileDropProps {
  onFile: (file: File) => void
  /** Name of the file currently loaded, if any. */
  currentName?: string
  currentSize?: number
  disabled?: boolean
  accept?: string
}

export function FileDrop({ onFile, currentName, currentSize, disabled, accept = 'audio/*,.wav,.mp3,.m4a,.ogg,.flac,.aac,.webm' }: FileDropProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handleFiles = useCallback((files: FileList | null) => {
    const file = files?.[0]
    if (file) onFile(file)
  }, [onFile])

  return (
    <div
      className={`panel-sunken grid place-items-center gap-2 px-4 py-6 text-center transition-colors ${
        dragging ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : ''
      } ${disabled ? 'opacity-50' : ''}`}
      onDragOver={(event) => {
        if (disabled) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (disabled) return
        event.preventDefault()
        setDragging(false)
        handleFiles(event.dataTransfer.files)
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          handleFiles(event.target.files)
          // Reset so re-picking the same file still fires a change event.
          event.target.value = ''
        }}
      />
      <Icon name="upload" size={20} className="text-[var(--text-faint)]" />
      {currentName ? (
        <p className="t-num max-w-full truncate text-[12px] text-[var(--text)]">
          {currentName}
          {currentSize !== undefined && <span className="text-[var(--text-faint)]"> · {formatBytes(currentSize)}</span>}
        </p>
      ) : (
        <p className="text-[13px] text-[var(--text-dim)]">
          Drop an audio file here, or choose one
        </p>
      )}
      <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => inputRef.current?.click()}>
        {currentName ? 'Choose a different file' : 'Choose file'}
      </button>
      <p className="text-[11px] text-[var(--text-faint)]">
        WAV, MP3, M4A, OGG, FLAC · stays on your device
      </p>
    </div>
  )
}
