// The recorder: ONE place that owns "are we recording?" for the whole app — the sidebar button, the
// live view, the tray and the pill all read/drive this. It picks the capture path from the runtime:
//   • desktop app / Chrome-Edge → meeting capture (your mic + the call's audio, two channels)
//   • phone / other browsers    → mic-only ambient capture (VAD-cut windows); on a phone paired with a
//                                  Mac, each window is saved (encrypted) first and sent when the Mac is reachable
// Every state change is published to the Electron main process (pill + tray) when running on desktop,
// and window.__sutraRecorder lets the main process start/stop with a user gesture (see electron/main.ts).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { detectCaptureCapability } from "../local/captureCapability";
import { createCaptureProvider } from "../capture/CaptureProvider";
import { MeetingController } from "../capture/meetingCapture";
import { CaptureController, pickMime } from "../lib/capture";
import { useWakeLock } from "../lib/useWakeLock";
import { api } from "../local/sutra";
import { desktop, type RecorderSnapshot } from "../desktop/bridge";
import { notifyDataChanged } from "./events";
import { friendlyError } from "./ui";
import { localSttReady } from "./Intelligence";
import { pairingActive } from "../pairing/model";
import { outbox } from "../pairing/runtime";

export type RecStatus = RecorderSnapshot["status"];

export interface RecorderState {
  status: RecStatus;
  startedAt: number | null;
  /** The meeting app being recorded ("Google Chrome"), when known. */
  app: string | null;
  mode: "meeting" | "mic" | null;
  level: number;
  turns: any[];
  inflight: number;
  error: string | null;
  /** Something worth saying that isn't an error (e.g. the recording is waiting on the phone for the Mac). */
  notice: string | null;
  sessionId: number | null;
  /** The conversation the most recent recording produced. */
  lastConversationId: number | null;
}

interface Recorder {
  state: RecorderState;
  start(opts?: { app?: string | null }): Promise<void>;
  stop(): Promise<void>;
  clearError(): void;
}

interface ActiveSession { stop(): Promise<void>; teardown(): void }

const INITIAL: RecorderState = {
  status: "idle", startedAt: null, app: null, mode: null, level: 0, turns: [], inflight: 0,
  error: null, notice: null, sessionId: null, lastConversationId: null,
};

export const SAVED_FOR_MAC = "Saved on your phone — it'll be transcribed when your Mac is reachable.";
const PART_FAILED = "Part of this recording couldn't be transcribed. It's kept on your phone — retry it in Settings → Your Mac.";

const Ctx = createContext<Recorder | null>(null);

export function useRecorder(): Recorder {
  const r = useContext(Ctx);
  if (!r) throw new Error("useRecorder outside RecorderProvider");
  return r;
}

export function RecorderProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RecorderState>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;
  const patch = useCallback((p: Partial<RecorderState> | ((s: RecorderState) => Partial<RecorderState>)) => {
    setState((s) => ({ ...s, ...(typeof p === "function" ? p(s) : p) }));
  }, []);
  const session = useRef<ActiveSession | null>(null);
  const level = useRef(0);

  // Keep the screen (and, on Android, the mic service) alive while recording.
  useWakeLock(state.status === "recording");

  // Level meter → state at ~8 Hz while recording (not on every audio chunk).
  useEffect(() => {
    if (state.status !== "recording") { patch({ level: 0 }); return; }
    const t = setInterval(() => patch({ level: level.current }), 125);
    return () => clearInterval(t);
  }, [state.status, patch]);

  const finished = useCallback(async (sid: number) => {
    const cid = await api.conversationForSession(sid).catch(() => null);
    patch({ lastConversationId: cid });
    notifyDataChanged();
  }, [patch]);

  const startMeeting = useCallback(async (app: string | null) => {
    const settings = await api.getSettings();
    const cap = detectCaptureCapability();
    const ctrl: MeetingController = new MeetingController({
      provider: createCaptureProvider(cap),
      api,
      micDeviceId: (settings["mic_device_id"] as string) || undefined,
      output: settings["audio_output"] === "speakers" ? "speakers" : "headphones",
      sourceApp: app,
      onError: (m) => { if (m) patch({ error: friendlyError(m) }); },
      onInflight: (n) => patch({ inflight: n }),
      onTurns: (t) => patch((s) => ({ turns: [...s.turns, ...t] })),
      onLevel: (me, them) => { level.current = Math.max(me, them); },
      onPhase: (phase) => {
        if (phase === "capturing") patch({ status: "recording", startedAt: Date.now(), sessionId: ctrl.sessionId });
        else if (phase === "processing") patch({ status: "processing" });
        else { session.current = null; patch({ status: "idle", sessionId: null, inflight: 0 }); }
      },
      onProcessed: (_r, sid) => finished(sid),
    });
    session.current = { stop: () => ctrl.stop(), teardown: () => ctrl.teardown() };
    await ctrl.start();
  }, [patch, finished]);

  const startMic = useCallback(async () => {
    const s = await api.createSession("mic", "ambient", null);
    const mime = pickMime();
    const ext = mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "webm";
    const uploads: Promise<unknown>[] = [];
    let inflight = 0;
    let lastCut = Date.now();
    // Paired with a Mac: windows go to the phone's encrypted queue, and the Mac's transcript comes back
    // through it whenever the Mac is reachable.
    const queue = !desktop && pairingActive(await api.getSettings()) ? outbox() : null;
    queue?.begin(s.id);
    const unsubscribe = queue?.subscribe((e) => {
      if ((e.t !== "ingested" && e.t !== "failed") || e.sessionId !== s.id) return;
      patch({ inflight: --inflight });
      if (e.t === "failed") patch({ error: PART_FAILED });
      else if (e.result?.turns?.length) patch((st) => ({ turns: [...st.turns, ...e.result.turns] }));
    });
    const ctrl = new CaptureController({
      onWindow: (blob, idx) => {
        const windowStartMs = lastCut;
        lastCut = Date.now();
        patch({ inflight: ++inflight });
        if (queue) {
          uploads.push(queue.enqueue(s.id, idx, blob, { filename: `window-${idx}.${ext}`, windowStartMs })
            .catch((e) => patch({ error: friendlyError(e), inflight: --inflight })));
          return;
        }
        uploads.push(
          api.ingestWindow(s.id, blob, idx, `window-${idx}.${ext}`, windowStartMs)
            .then((r: any) => { if (r?.turns?.length) patch((st) => ({ turns: [...st.turns, ...r.turns] })); })
            .catch((e) => patch({ error: friendlyError(e) }))
            .finally(() => patch({ inflight: --inflight })),
        );
      },
      onLevel: (rms) => { level.current = rms; },
      onError: (m) => patch({ error: friendlyError(m) }),
    });
    let stopped = false;
    session.current = {
      teardown: () => { unsubscribe?.(); void ctrl.stop(); },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await ctrl.stop();
        patch({ status: "processing" });
        try {
          await Promise.allSettled(uploads);
          await api.closeSession(s.id);
          if (queue) {
            // The queue's worker writes the notes once everything has reached the Mac.
            await queue.closeSession(s.id);
            await queue.drain();
            if (await queue.isWaiting(s.id)) patch({ notice: SAVED_FOR_MAC, lastConversationId: null });
            else await finished(s.id);
          } else {
            const r: any = await api.processSession(s.id);
            if (r?.failed > 0) patch({ error: `Processed with issues — ${r.failed} part(s) failed${r.lastError ? ": " + r.lastError : ""}.` });
            await finished(s.id);
          }
        } catch (e) {
          patch({ error: friendlyError(e) });
        } finally {
          unsubscribe?.();
          session.current = null;
          patch({ status: "idle", sessionId: null, inflight: 0 });
        }
      },
    };
    try {
      await ctrl.start();
    } catch (e) {
      unsubscribe?.();
      session.current = null;
      await api.closeSession(s.id).catch(() => {});
      await queue?.closeSession(s.id).catch(() => {});
      throw e;
    }
    patch({ status: "recording", startedAt: Date.now(), sessionId: s.id });
  }, [patch, finished]);

  const start = useCallback(async (opts?: { app?: string | null }) => {
    if (stateRef.current.status !== "idle") return;
    const meeting = detectCaptureCapability().supported;
    const app = opts?.app ?? null;
    patch({ ...INITIAL, status: "starting", app, mode: meeting ? "meeting" : "mic", lastConversationId: stateRef.current.lastConversationId });
    try {
      const notReady = await localSttReady(await api.getSettings());
      if (notReady) throw new Error(notReady);
      if (meeting) await startMeeting(app);
      else await startMic();
    } catch (e) {
      session.current = null;
      patch({ status: "idle", error: friendlyError(e) });
    }
  }, [patch, startMeeting, startMic]);

  const stop = useCallback(async () => {
    const s = session.current;
    if (!s || stateRef.current.status !== "recording") return;
    await s.stop();
  }, []);

  const clearError = useCallback(() => patch({ error: null, notice: null }), [patch]);

  // Never orphan a live MediaStream / AudioContext if the provider unmounts.
  useEffect(() => () => session.current?.teardown(), []);

  // Desktop: let the main process drive us (pill / tray), with a user gesture for getDisplayMedia.
  useEffect(() => {
    (window as any).__sutraRecorder = {
      start: (o?: { app?: string | null }) => start(o),
      stop: () => stop(),
    };
    return () => { delete (window as any).__sutraRecorder; };
  }, [start, stop]);

  // Desktop: publish the snapshot the pill + tray render (levels are rounded so small jitter is cheap).
  const publishKey = `${state.status}|${state.startedAt}|${state.app}|${state.lastConversationId}|${state.error}|${Math.round(state.level * 200)}`;
  useEffect(() => {
    desktop?.recorder.publish({
      status: state.status, startedAt: state.startedAt, app: state.app, level: state.level,
      conversationId: state.lastConversationId, error: state.error,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishKey]);

  const value = useMemo(() => ({ state, start, stop, clearError }), [state, start, stop, clearError]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Re-render every second while recording, for clocks. */
export function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs]);
  return now;
}
