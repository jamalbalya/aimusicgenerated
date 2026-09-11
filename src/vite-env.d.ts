/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** True in single-file builds, where the worker is embedded in the document. */
  readonly VITE_INLINE_WORKER: boolean
  /** Application version, from package.json. See src/lib/buildInfo.ts. */
  readonly VITE_APP_VERSION: string
  /** Short commit this build was made from, or `dev`. */
  readonly VITE_BUILD_SHA: string
  /** ISO timestamp of the build. */
  readonly VITE_BUILD_TIME: string
  /** OAuth public client id. Public by design; a public client has no secret. */
  readonly VITE_HF_CLIENT_ID: string
  readonly VITE_HF_PROVIDER_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
