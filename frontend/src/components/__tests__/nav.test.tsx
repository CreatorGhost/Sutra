// Nav reachability + capability gating (ticket F7).
// The Meeting tab must appear ONLY where two-channel meeting capture is possible
// (detectCaptureCapability().supported), and be hidden on every unsupported reason
// (mobile/Capacitor-native, Safari, Firefox, Chromium-without-getDisplayMedia). We assert the gate
// two ways:
//   1. navItemsFor(supported) — the pure builder Nav uses — for the precise list shape.
//   2. detectCaptureCapability(fakeEnv) → navItemsFor(cap.supported), against a fake CaptureEnv for
//      the supported case AND each unsupported reason, so the wiring (capability → nav) is covered.
import { describe, it, expect } from "vitest";
import { navItemsFor } from "../Nav";
import { detectCaptureCapability, type CaptureEnv } from "../../local/captureCapability";

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const FIREFOX_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:124.0) Gecko/20100101 Firefox/124.0";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";

const withDisplayMedia = () => ({ getDisplayMedia: () => {}, getUserMedia: () => {} });
const meetingTos = (supported: boolean) => navItemsFor(supported).map((i) => i.to);

describe("Nav meeting gating", () => {
  it("navItemsFor(true) includes /meeting between Memory and Ask", () => {
    expect(meetingTos(true)).toEqual(["/", "/memory", "/meeting", "/chat", "/settings"]);
  });

  it("navItemsFor(false) omits /meeting (base nav unchanged)", () => {
    expect(meetingTos(false)).toEqual(["/", "/memory", "/chat", "/settings"]);
    expect(meetingTos(false)).not.toContain("/meeting");
  });

  // ── capability → nav wiring, against a fake CaptureEnv per the F7 acceptance ──────────────────
  it("Electron renderer (supported) -> Meeting tab visible", () => {
    const env: CaptureEnv = { sutraDesktop: {}, navigator: { userAgent: CHROME_UA } };
    expect(meetingTos(detectCaptureCapability(env).supported)).toContain("/meeting");
  });

  it("Chromium desktop with getDisplayMedia (supported) -> Meeting tab visible", () => {
    const env: CaptureEnv = { navigator: { userAgent: CHROME_UA, mediaDevices: withDisplayMedia() } };
    expect(meetingTos(detectCaptureCapability(env).supported)).toContain("/meeting");
  });

  it.each<[string, CaptureEnv]>([
    ["mobile / Capacitor-native", {
      navigator: { userAgent: ANDROID_UA, mediaDevices: withDisplayMedia() },
      Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
    }],
    ["Safari", { navigator: { userAgent: SAFARI_UA, mediaDevices: withDisplayMedia() } }],
    ["Firefox", { navigator: { userAgent: FIREFOX_UA, mediaDevices: withDisplayMedia() } }],
    ["Chromium without getDisplayMedia", { navigator: { userAgent: CHROME_UA } }],
  ])("%s (unsupported) -> Meeting tab hidden", (_name, env) => {
    const cap = detectCaptureCapability(env);
    expect(cap.supported).toBe(false);
    expect(meetingTos(cap.supported)).not.toContain("/meeting");
  });
});
