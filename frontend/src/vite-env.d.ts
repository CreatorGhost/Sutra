/// <reference types="vite/client" />

// Custom env vars exposed to the client at build time (must be VITE_-prefixed).
interface ImportMetaEnv {
  /** Optional proxy base URL. Android USB defaults to http://localhost:8787 via adb reverse. */
  readonly VITE_PROXY_URL?: string;
  /** Optional shared secret sent as X-Sutra-Secret to the proxy. Unset over USB. */
  readonly VITE_PROXY_SECRET?: string;
  /** Tier B (hosted, opt-in) server-variant base URL for /auth/* and /sync. Separate from the proxy.
   *  Defaults to http://localhost:8000 in dev; set for a hosted deployment. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
