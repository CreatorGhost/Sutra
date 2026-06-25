import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Monitor, Mic, Square, Play, Loader2, ShieldCheck, Headphones, Download, RotateCcw } from "lucide-react";
import { detectCaptureCapability } from "../local/captureCapability";
import { createCaptureProvider } from "../capture/CaptureProvider";
import { MeetingController, type MeetingPhase, NO_AUDIO_TRACK_MESSAGE } from "../capture/meetingCapture";
import type { AudioOutputKind } from "../capture/stereoCore";
import { api } from "../local/sutra";
import { Chip, ErrorBar } from "../components/ui";

// Online-meeting capture (ticket F6 — approach #1 "WAV-at-the-edge, controller-mirror").
// The SAME capability probe that the factory uses gates this page:
//   • unsupported context (Safari/Firefox/mobile/DOM-less SSR) → a calm fallback (no crash) with the
//     capability reason + the audio-never-stored privacy line (GATE PRESERVED — meetingPage.test.tsx).
//   • supported context (Electron / Chrome-Edge desktop) → the real two-channel capture UI. Start opens
//     a session + starts the provider; each ~90s window is WAV-encoded in-flight and ingested as
//     multichannel (mic=ch0 "Me", system=ch1 remotes); Stop drains uploads → closes → processes.
// Audio is NEVER persisted: a window's PCM becomes a WAV Blob only for the in-flight ingest call.
export default function Meeting() {
  const capability = useMemo(() => detectCaptureCapability(), []);
  // Resolve the provider through the SAME contract whether Electron or browser — the render path below
  // never touches an Electron-only API, so the identical UI renders in both shells.
  const provider = useMemo(() => createCaptureProvider(capability), [capability]);

  // --- capture state (driven by the controller's callbacks) ---
  const [phase, setPhase] = useState<MeetingPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [inflight, setInflight] = useState(0);
  const [windowsEmitted, setWindowsEmitted] = useState(0);
  const [turnCount, setTurnCount] = useState(0);

  // --- source pickers ---
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState<string>("");
  const [output, setOutput] = useState<AudioOutputKind>("headphones");

  // --- PWA install affordance ---
  const [installEvt, setInstallEvt] = useState<any>(null);

  const ctrlRef = useRef<MeetingController | null>(null);

  const capturing = phase === "capturing";
  const processing = phase === "processing";
  const ended = phase === "ended"; // stream-ended recovery → offer Restart

  // Enumerate input devices so the user can pick a mic (labels appear once any permission is granted).
  useEffect(() => {
    if (!capability.supported) return;
    const md = navigator?.mediaDevices;
    if (!md?.enumerateDevices) return;
    md.enumerateDevices()
      .then((ds) => setMics(ds.filter((d) => d.kind === "audioinput")))
      .catch(() => {});
  }, [capability.supported]);

  // PWA install: capture the deferred prompt; hide once installed or already standalone.
  useEffect(() => {
    const isStandalone =
      (typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)")?.matches) ||
      (typeof navigator !== "undefined" && (navigator as any).standalone === true);
    if (isStandalone) return;
    const onPrompt = (e: Event) => { e.preventDefault(); setInstallEvt(e); };
    const onInstalled = () => setInstallEvt(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Tear down a still-live capture on unmount so no MediaStream/AudioContext is orphaned (fire-and-forget).
  useEffect(() => () => { ctrlRef.current?.teardown(); ctrlRef.current = null; }, []);

  const start = useCallback(async () => {
    setError(null);
    setTurnCount(0);
    const ctrl = new MeetingController({
      provider,
      api,
      micDeviceId: micDeviceId || undefined,
      output,
      onError: setError,
      onInflight: setInflight,
      onWindows: setWindowsEmitted,
      onTurns: (t) => setTurnCount((n) => n + t.length),
      onPhase: setPhase,
    });
    ctrlRef.current = ctrl;
    await ctrl.start();
  }, [provider, micDeviceId, output]);

  const stop = useCallback(async () => {
    await ctrlRef.current?.stop();
    ctrlRef.current = null;
  }, []);

  const installApp = useCallback(async () => {
    const e = installEvt; if (!e) return;
    try { await e.prompt(); } catch { /* ignore */ }
    setInstallEvt(null);
  }, [installEvt]);

  // --- unsupported fallback (GATE PRESERVED) ----------------------------------------------------
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

  // --- supported capture UI ----------------------------------------------------------------------
  const statusText = processing
    ? "Processing…"
    : capturing
      ? inflight > 0 ? "Capturing — transcribing windows…" : "Capturing the meeting"
      : ended
        ? "Capture ended — the share stopped"
        : "Ready";
  const dotClass = capturing ? "live" : processing || inflight > 0 ? "proc" : "idle";

  return (
    <div className="page fade-in" style={{ paddingBottom: "calc(var(--nav-h) + var(--sab) + 8px)" }}>
      <span className="sr-only" role="status" aria-live="assertive">
        {capturing ? "Meeting capture in progress" : processing ? "Processing meeting" : ended ? "Capture ended" : ""}
      </span>
      <ErrorBar message={error} onDismiss={() => setError(null)} />

      <div className="hero">
        <div style={{ fontSize: "var(--fs-body)", color: "var(--muted)", marginBottom: 4 }}>Meeting capture</div>

        {/* Live status region — windows + in-flight, screen-reader friendly. */}
        <div className="status-line" role="status" aria-live="polite">
          <span className={`status-dot ${dotClass}`} />
          {statusText}
          {inflight > 0 && <Loader2 size={14} className="spin" />}
        </div>

        {/* Source / mic indicators. */}
        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          <Chip kind="">{provider.kind === "electron" ? "electron loopback" : "browser tab/system"}</Chip>
          <Chip kind=""><span className="row" style={{ gap: 4 }}><Monitor size={12} /> system → remotes</span></Chip>
          <Chip kind=""><span className="row" style={{ gap: 4 }}><Mic size={12} /> mic → me</span></Chip>
          {windowsEmitted > 0 && <Chip kind="">{windowsEmitted} windows emitted</Chip>}
          {turnCount > 0 && <Chip kind="ok">{turnCount} turns</Chip>}
        </div>

        {/* Mic picker + output toggle. */}
        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          <label className="row" style={{ gap: 6, fontSize: "var(--fs-s)" }}>
            <Mic size={14} />
            <select
              aria-label="Microphone"
              value={micDeviceId}
              onChange={(e) => setMicDeviceId(e.target.value)}
              disabled={capturing || processing}
              style={{ maxWidth: 200 }}
            >
              <option value="">Default microphone</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>{m.label || "Microphone"}</option>
              ))}
            </select>
          </label>
          <button
            className={`btn sm ${output === "headphones" ? "" : "ghost"}`}
            onClick={() => setOutput((o) => (o === "headphones" ? "speakers" : "headphones"))}
            disabled={capturing || processing}
            aria-pressed={output === "headphones"}
          >
            <Headphones size={14} /> {output === "headphones" ? "Headphones" : "Speakers"}
          </button>
        </div>

        {/* Start / Stop / Restart. */}
        <div className="row" style={{ gap: 10, marginTop: 14 }}>
          {capturing ? (
            <button className="btn danger sm" onClick={stop} disabled={processing}>
              <Square size={15} /> Stop &amp; process
            </button>
          ) : ended ? (
            <button className="btn sm" onClick={start} disabled={processing}>
              <RotateCcw size={15} /> Restart capture
            </button>
          ) : (
            <button className="btn sm" onClick={start} disabled={processing}>
              <Play size={15} /> Start
            </button>
          )}
          {installEvt && (
            <button className="btn ghost sm" onClick={installApp}>
              <Download size={15} /> Install app
            </button>
          )}
        </div>

        {/* Headphone hint + Bluetooth-SCO warning. */}
        <div className="card" style={{ marginTop: 16, fontSize: "var(--fs-s)" }}>
          <div className="row" style={{ gap: 8 }}>
            <Headphones size={15} color="var(--accent-2)" style={{ flexShrink: 0 }} />
            <span>Wear headphones for the cleanest capture — two pristine channels with no echo.</span>
          </div>
          <div className="row faint" style={{ gap: 8, marginTop: 8, fontSize: "var(--fs-xs)" }}>
            <span>
              Heads-up: some Bluetooth headsets (AirPods on a call) drop the mic to low-quality 8 kHz mono
              (SCO). A wired or USB mic gives the best “Me” channel.
            </span>
          </div>
        </div>

        {/* Always-on privacy line. */}
        <div className="row capture-reassure" style={{ marginTop: 14 }}>
          <ShieldCheck size={15} color="var(--ok)" style={{ flexShrink: 0 }} />
          <span style={{ fontSize: "var(--fs-s)" }}>Audio is processed live and never stored.</span>
        </div>
      </div>
    </div>
  );
}

export { NO_AUDIO_TRACK_MESSAGE };
