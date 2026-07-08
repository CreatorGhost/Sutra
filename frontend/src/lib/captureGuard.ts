// Module-scoped recording guard so any screen (Nav links, hardware back) can ask "is a recording in
// progress?" and end it cleanly — by running Capture's FULL stop flow (drain → close → process), not
// just tearing down the mic. Capture registers/clears the function via setCaptureGuard.
let _active = false;
let _endAndProcess: (() => Promise<void>) | null = null;

export function captureActive(): boolean { return _active; }

export function setCaptureGuard(active: boolean, endAndProcess: (() => Promise<void>) | null): void {
  _active = active;
  _endAndProcess = endAndProcess;
}

export async function endCapture(): Promise<void> {
  const fn = _endAndProcess;
  _endAndProcess = null;
  _active = false;
  if (fn) await fn();
}
