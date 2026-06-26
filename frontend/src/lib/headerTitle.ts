import { useSyncExternalStore } from "react";

/** Static path → header title. The single source of truth for the app bar's screen title on
 *  top-level/static routes (detail pages publish a dynamic title via setHeaderTitle instead).
 *  Includes /meeting (ticket F7) so the online-meeting capture screen has a real, non-empty title. */
const STATIC_TITLES: Record<string, string> = {
  "/": "Sutra",
  "/meeting": "Meeting",
  "/memory": "Memory",
  "/graph": "Graph",
  "/chat": "Ask Sutra",
  "/settings": "Settings",
  "/settings/capture": "Capture & language",
  "/settings/context": "Your Context",
  "/settings/people": "People & voices",
  "/settings/account": "Account",
  "/settings/connections": "Connections",
  "/settings/recap": "Daily recap",
  "/settings/advanced": "Advanced",
  "/signin": "Cloud sync",
};

/** Resolve the header title for a static route. Returns a non-empty string for every known path
 *  (including "/meeting") and falls back to the brand for anything else, so the app bar is never
 *  blank. `overrides` lets the Header inject runtime labels (e.g. the Projects label) without this
 *  module importing repo-layer constants. */
export function titleForPath(pathname: string, overrides?: Record<string, string>): string {
  return overrides?.[pathname] ?? STATIC_TITLES[pathname] ?? "Sutra";
}

/** Tiny module-scoped store so a detail page can publish its loaded title to the
 *  shared Header without prop-drilling or context plumbing. SSR-safe (lazy reads,
 *  no window access). ConversationDetail sets it on load and clears it on unmount. */
let current: string | null = null;
const listeners = new Set<() => void>();

export function setHeaderTitle(title: string | null) {
  if (current === title) return;
  current = title;
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return current;
}

/** Read the current dynamic header title (null when none is set). */
export function useHeaderTitle() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** A trailing icon-button the active page can publish to the Header (currently only Share). */
export type HeaderAction = { label: string; onTap: () => void };
let action: HeaderAction | null = null;
const actionListeners = new Set<() => void>();
export function setHeaderAction(a: HeaderAction | null) {
  action = a;
  actionListeners.forEach((l) => l());
}
export function useHeaderAction() {
  return useSyncExternalStore(
    (cb) => { actionListeners.add(cb); return () => actionListeners.delete(cb); },
    () => action, () => action,
  );
}

/** Live capture status the Header shows in place of the brand on "/" (non-interactive). */
export type HeaderStatus = { kind: "rec" | "paused" | "proc"; text: string };
let status: HeaderStatus | null = null;
const statusListeners = new Set<() => void>();
export function setHeaderStatus(s: HeaderStatus | null) {
  status = s;
  statusListeners.forEach((l) => l());
}
export function useHeaderStatus() {
  return useSyncExternalStore(
    (cb) => { statusListeners.add(cb); return () => statusListeners.delete(cb); },
    () => status, () => status,
  );
}
