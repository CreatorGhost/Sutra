import { useMemo } from "react";
import { detectCaptureCapability } from "../local/captureCapability";
import { createCaptureProvider } from "../capture/CaptureProvider";

// Online-meeting capture entry (ticket F1 — stub page + capability gate, approach #3).
// The SAME capability probe that the factory uses decides what this page renders:
//   • unsupported context (Safari/Firefox/mobile/jsdom) → a calm fallback explaining the requirement,
//     never a crash. Includes the audio-never-stored privacy line.
//   • supported context (Electron / Chrome-Edge desktop) → the stub placeholder. The two-channel
//     capture UI + engine arrive in F2/M5; here we only prove the gate and provider wiring.
export default function Meeting() {
  const capability = useMemo(() => detectCaptureCapability(), []);
  // Resolve the provider so the seam is exercised (start/stop are F2 stubs; not called here).
  const provider = useMemo(() => createCaptureProvider(capability), [capability]);

  if (!capability.supported) {
    return (
      <div className="page fade-in" style={{ paddingBottom: "calc(var(--nav-h) + var(--sab) + 8px)" }}>
        <div className="empty fade-in">
          <div style={{ fontSize: "var(--fs-body)", color: "var(--muted)", marginBottom: 4 }}>
            Meeting capture needs the desktop app or Chrome/Edge
          </div>
          <div style={{ fontSize: "var(--fs-s)" }}>{capability.reason}</div>
          <div style={{ fontSize: "var(--fs-s)", marginTop: 12, opacity: 0.8 }}>
            Your privacy is unchanged: meeting audio is processed live and never stored.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page fade-in" style={{ paddingBottom: "calc(var(--nav-h) + var(--sab) + 8px)" }}>
      <div className="empty fade-in">
        <div style={{ fontSize: "var(--fs-body)", color: "var(--muted)", marginBottom: 4 }}>
          Meeting capture
        </div>
        <div style={{ fontSize: "var(--fs-s)" }}>
          Ready on this device ({provider.kind}). Two-channel capture lands next.
        </div>
        <div style={{ fontSize: "var(--fs-s)", marginTop: 12, opacity: 0.8 }}>
          Audio is processed live and never stored.
        </div>
      </div>
    </div>
  );
}
