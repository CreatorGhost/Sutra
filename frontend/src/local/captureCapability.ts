// Pure capability probe for online-meeting capture (ticket F1, approach #3:
// "capability-result-as-contract"). ONE deterministic function decides whether two-channel
// meeting capture is possible in the current runtime. Its result drives three consumers:
//   1. the capture factory (createCaptureProvider) — Electron bridge vs browser,
//   2. the storage seam (informational; storage stays db.ts today),
//   3. the /meeting route gate in App.tsx (supported page vs "use the desktop app / Chrome-Edge").
//
// Per MEETING-CAPTURE-SPEC §4–5 and §11: Safari & Firefox capture ZERO system audio (engine
// limit, every version) → unsupported; mobile/Capacitor-native getDisplayMedia system-audio is
// restricted → unsupported; the Electron renderer has native loopback in the main process → always
// supported; Chromium desktop with getDisplayMedia is the web path → supported.
//
// PURE + injectable: pass an `env` for tests; defaults read the real globals. No side effects,
// no DOM mutation, safe to import in jsdom/node (every global access is optional-chained/guarded).

/** The single capability contract consumed across the meeting-capture feature. */
export interface CaptureCapability {
  /** True when two-channel meeting capture is possible in this runtime. */
  supported: boolean;
  /** Running inside the Electron renderer (preload bridge present) — native loopback available.
   *  Drives the capture-provider choice (Electron vs browser). */
  isElectron: boolean;
  /** Short, user-facing reason when unsupported (empty when supported). */
  reason: string;
}

/** Injectable view of the globals this probe inspects. All optional so a partial fake is enough. */
export interface CaptureEnv {
  navigator?: {
    userAgent?: string;
    mediaDevices?: { getDisplayMedia?: unknown; getUserMedia?: unknown };
    /** Capacitor injects this on native; web leaves it undefined. */
    product?: string;
  };
  /** Electron's contextIsolation preload bridge (see electron/preload.ts). Presence ⇒ desktop app. */
  sutraDesktop?: unknown;
  /** Capacitor global, present in the native WebView (mobile). */
  Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
}

function defaultEnv(): CaptureEnv {
  const g = (typeof globalThis !== "undefined" ? globalThis : {}) as Record<string, unknown>;
  const nav = (typeof navigator !== "undefined" ? navigator : undefined) as CaptureEnv["navigator"];
  return {
    navigator: nav,
    sutraDesktop: g["sutraDesktop"],
    Capacitor: g["Capacitor"] as CaptureEnv["Capacitor"],
  };
}

/** Heuristic Chromium detection from the UA string. Only reached on the desktop, non-mobile path
 *  (the mobile/iOS WebKit cases are handled by isNativeMobile first), so this just has to tell
 *  Chromium (Chrome/Edge/Opera all carry "Chrome/") apart from Safari and Firefox. */
function detectChromium(ua: string): boolean {
  if (/Firefox\//.test(ua)) return false;
  return /Chrome\//.test(ua) || /Chromium\//.test(ua) || /Electron\//.test(ua);
}

function isNativeMobile(env: CaptureEnv): boolean {
  const cap = env.Capacitor;
  if (cap?.isNativePlatform?.()) return true;
  const product = env.navigator?.product;
  if (product === "ReactNative") return true;
  const ua = env.navigator?.userAgent ?? "";
  return /Android|iPhone|iPad|iPod/i.test(ua);
}

/**
 * Decide whether meeting capture is supported in the given (or ambient) runtime.
 * PURE: same input ⇒ same output, no globals mutated. Defaults to the real environment.
 */
export function detectCaptureCapability(env: CaptureEnv = defaultEnv()): CaptureCapability {
  const ua = env.navigator?.userAgent ?? "";
  const isElectron = env.sutraDesktop != null || /Electron\//.test(ua);

  // 1) Electron renderer: native loopback lives in the main process (electron/main.ts), so the
  //    renderer is supported regardless of getDisplayMedia presence.
  if (isElectron) return { supported: true, isElectron: true, reason: "" };

  // 2) Mobile / Capacitor-native WebView: getDisplayMedia system-audio is restricted (spec §11).
  if (isNativeMobile(env)) {
    return {
      supported: false,
      isElectron: false,
      reason: "Meeting capture isn't available on mobile. Use the desktop app or Chrome/Edge on a computer.",
    };
  }

  // 3) Non-Chromium desktop (Safari / Firefox): zero system audio on every version (spec §4).
  if (!detectChromium(ua)) {
    return {
      supported: false,
      isElectron: false,
      reason: "Safari and Firefox can't capture meeting audio. Use the desktop app or Chrome/Edge.",
    };
  }

  // 4) Chromium desktop: needs getDisplayMedia for system/tab audio.
  if (typeof env.navigator?.mediaDevices?.getDisplayMedia !== "function") {
    return {
      supported: false,
      isElectron: false,
      reason: "This browser can't share system audio. Use the desktop app or an updated Chrome/Edge.",
    };
  }

  return { supported: true, isElectron: false, reason: "" };
}
