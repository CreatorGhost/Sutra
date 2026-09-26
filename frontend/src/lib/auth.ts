// Optional per-user proxy token. The self-hosted / dev proxy needs none (requests go out
// unauthenticated or with VITE_PROXY_SECRET); a hosted proxy can issue a bearer token that is kept
// here. The sign-in UI that used to write it was never committed, so this is intentionally tiny.
const KEY = "sutra_token";

export function readToken(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function saveToken(token: string): void {
  try { localStorage.setItem(KEY, token); } catch { /* storage blocked */ }
}

export function clearToken(): void {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}
