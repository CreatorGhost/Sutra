// Unit tests for detectCaptureCapability — the PURE capability contract that drives the capture
// factory, the storage seam, and the /meeting route gate (ticket F1, approach #3). No DOM, no
// network: exercises the REAL exported function against injected fake environments.
import { describe, it, expect } from "vitest";
import { detectCaptureCapability, type CaptureEnv } from "../captureCapability";

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const FIREFOX_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:124.0) Gecko/20100101 Firefox/124.0";
const ELECTRON_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Sutra/1.0.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";

const withDisplayMedia = () => ({ getDisplayMedia: () => {}, getUserMedia: () => {} });

describe("detectCaptureCapability", () => {
  it("Electron renderer (preload bridge present) -> supported", () => {
    const env: CaptureEnv = { sutraDesktop: {}, navigator: { userAgent: ELECTRON_UA } };
    const cap = detectCaptureCapability(env);
    expect(cap.supported).toBe(true);
    expect(cap.isElectron).toBe(true);
    expect(cap.reason).toBe("");
  });

  it("Chromium desktop with getDisplayMedia audio -> supported", () => {
    const env: CaptureEnv = { navigator: { userAgent: CHROME_UA, mediaDevices: withDisplayMedia() } };
    const cap = detectCaptureCapability(env);
    expect(cap.supported).toBe(true);
    expect(cap.isElectron).toBe(false);
  });

  it("Safari (non-Chromium) -> unsupported with a reason", () => {
    const env: CaptureEnv = { navigator: { userAgent: SAFARI_UA, mediaDevices: withDisplayMedia() } };
    const cap = detectCaptureCapability(env);
    expect(cap.supported).toBe(false);
    expect(cap.reason).not.toBe("");
  });

  it("Firefox (non-Chromium) -> unsupported with a reason", () => {
    const env: CaptureEnv = { navigator: { userAgent: FIREFOX_UA, mediaDevices: withDisplayMedia() } };
    const cap = detectCaptureCapability(env);
    expect(cap.supported).toBe(false);
    expect(cap.reason).not.toBe("");
  });

  it("Capacitor-native / mobile -> unsupported with a reason", () => {
    const nativeEnv: CaptureEnv = {
      navigator: { userAgent: ANDROID_UA, mediaDevices: withDisplayMedia() },
      Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
    };
    const cap = detectCaptureCapability(nativeEnv);
    expect(cap.supported).toBe(false);
    expect(cap.reason).not.toBe("");

    // Even a mobile Chromium UA without the Capacitor flag is gated by the UA mobile check.
    const mobileWeb = detectCaptureCapability({
      navigator: { userAgent: ANDROID_UA, mediaDevices: withDisplayMedia() },
    });
    expect(mobileWeb.supported).toBe(false);
    expect(mobileWeb.reason).not.toBe("");
  });

  it("Chromium desktop WITHOUT getDisplayMedia -> unsupported with a reason", () => {
    const env: CaptureEnv = { navigator: { userAgent: CHROME_UA } };
    const cap = detectCaptureCapability(env);
    expect(cap.supported).toBe(false);
    expect(cap.reason).not.toBe("");
  });

  it("is callable with no argument (reads ambient globals) and never throws", () => {
    expect(() => detectCaptureCapability()).not.toThrow();
    const cap = detectCaptureCapability();
    expect(typeof cap.supported).toBe("boolean");
  });
});
