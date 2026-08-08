/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend origin. Empty = same-origin (dev proxy in Vite, nginx in prod). */
  readonly VITE_BACKEND_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
