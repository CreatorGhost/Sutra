import { Capacitor, registerPlugin } from "@capacitor/core";

interface ForegroundMicPlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
  routeToBuiltinMic(): Promise<void>;
}

const Plugin = registerPlugin<ForegroundMicPlugin>("ForegroundMic");

/** Keep the mic alive with the screen off (Android foreground service). No-op on web/iOS. */
export const ForegroundMic = {
  async start(): Promise<void> {
    if (Capacitor.getPlatform() === "android") {
      try { await Plugin.start(); } catch { /* plugin unavailable in browser */ }
    }
  },
  async stop(): Promise<void> {
    if (Capacitor.getPlatform() === "android") {
      try { await Plugin.stop(); } catch { /* ignore */ }
    }
  },
  /** Android: pin capture to the built-in mic so Chromium doesn't pick a Bluetooth HFP/SCO
   *  comms device (paired watch/carkit) that can't bind -> getUserMedia NotReadableError. */
  async routeToBuiltinMic(): Promise<void> {
    if (Capacitor.getPlatform() === "android") {
      try { await Plugin.routeToBuiltinMic(); } catch { /* ignore */ }
    }
  },
};
