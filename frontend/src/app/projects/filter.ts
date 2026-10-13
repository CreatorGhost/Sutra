// The sidebar's "only this project" filter. Lives outside the router so it survives opening a meeting;
// a tiny external store keeps it out of App state.
import { useSyncExternalStore } from "react";

let current: number | null = null;
const subs = new Set<() => void>();

export function setMeetingFilter(projectId: number | null): void {
  current = projectId;
  subs.forEach((f) => f());
}

export function useMeetingFilter(): number | null {
  return useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f); }; },
    () => current,
  );
}
