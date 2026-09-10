/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** True in single-file builds, where the worker is embedded in the document. */
  readonly VITE_INLINE_WORKER: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
