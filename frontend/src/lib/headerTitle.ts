import { useSyncExternalStore } from "react";

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
