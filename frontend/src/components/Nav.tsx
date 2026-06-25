import { useMemo, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Mic, Library, MessageSquare, Settings as Cog, MonitorPlay } from "lucide-react";
import { captureActive, endCapture } from "../lib/captureGuard";
import { detectCaptureCapability } from "../local/captureCapability";

const baseItems = [
  { to: "/", label: "Home", icon: Mic },
  { to: "/memory", label: "Memory", icon: Library },
  { to: "/chat", label: "Ask", icon: MessageSquare },
  { to: "/settings", label: "Settings", icon: Cog },
];

// The Meeting tab is shown ONLY where two-channel meeting capture is possible (Electron renderer or
// Chromium desktop with getDisplayMedia — detectCaptureCapability().supported). On mobile/Capacitor-
// native and Safari/Firefox it's hidden, so the nav never advertises a feature the runtime can't do.
// (/meeting still routes — typed directly or via deep link — to the page's calm capability fallback.)
const MEETING_ITEM = { to: "/meeting", label: "Meeting", icon: MonitorPlay };

/** Build the nav items for the given capability — pure so the gating is unit-testable against a fake
 *  CaptureEnv (supported vs each unsupported reason). Meeting slots between Memory and Ask. */
export function navItemsFor(supported: boolean) {
  return supported
    ? [baseItems[0], baseItems[1], MEETING_ITEM, ...baseItems.slice(2)]
    : baseItems;
}

export function Nav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Probe once per mount — the runtime (UA / preload bridge) doesn't change within a session.
  const items = useMemo(() => navItemsFor(detectCaptureCapability().supported), []);
  // Leaving Capture mid-recording would silently drop it — intercept the tap and confirm first.
  const [pending, setPending] = useState<string | null>(null);

  return (
    // NavLink sets aria-current="page" on the active anchor automatically.
    <nav className="nav" aria-label="Primary">
      {items.map(({ to, label, icon: Icon }) => (
        <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => (isActive ? "active" : "")}
          onClick={(e) => { if (captureActive() && to !== pathname) { e.preventDefault(); setPending(to); } }}>
          <Icon size={21} strokeWidth={2} aria-hidden="true" />
          <span>{label}</span>
        </NavLink>
      ))}

      {pending && (
        <>
          <div className="sheet-scrim" onClick={() => setPending(null)} />
          <div className="sheet" role="dialog" aria-modal="true" aria-label="End recording?">
            <div className="grabber" />
            <h3 style={{ marginTop: 0 }}>End recording?</h3>
            <p className="muted" style={{ fontSize: "var(--fs-s)", marginBottom: 16 }}>It'll be saved and keep processing in the background.</p>
            <button className="btn primary block" style={{ marginBottom: 10 }}
              onClick={() => {
                const to = pending; setPending(null);
                // Fire-and-forget: endCapture()'s synchronous prefix flags the stop as in-flight
                // (stoppingRef in Capture) BEFORE navigate unmounts Capture, so the unmount cleanup
                // can't start a second stop — and the user isn't stuck waiting on processing.
                void endCapture();
                if (to) navigate(to);
              }}>End &amp; save</button>
            <button className="btn ghost block" onClick={() => setPending(null)}>Keep recording</button>
          </div>
        </>
      )}
    </nav>
  );
}
