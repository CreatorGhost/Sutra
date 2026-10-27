import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { Keyboard, KeyboardResize, KeyboardStyle } from "@capacitor/keyboard";
import { StatusBar, Style } from "@capacitor/status-bar";

function isLightTheme(): boolean {
  return document.documentElement.getAttribute("data-theme") === "light";
}

export async function syncNativeChrome(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const platform = Capacitor.getPlatform();
  const light = isLightTheme();
  try {
    await StatusBar.show();
    await StatusBar.setStyle({ style: light ? Style.Light : Style.Dark });
    if (platform === "android") {
      await StatusBar.setOverlaysWebView({ overlay: false });
      await StatusBar.setBackgroundColor({ color: light ? "#f5f4fb" : "#0a0912" });
    }
  } catch {
    /* Native chrome support is best-effort per platform/plugin version. */
  }

  try {
    if (platform === "ios") {
      await Keyboard.setResizeMode({ mode: KeyboardResize.Body });
      await Keyboard.setStyle({ style: KeyboardStyle.Default });
      await Keyboard.setAccessoryBarVisible({ isVisible: false });
      await Keyboard.setScroll({ isDisabled: false });
    }
  } catch {
    /* Keyboard APIs vary by platform; CSS visualViewport remains the fallback. */
  }
}

export async function tapHaptic(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    /* Haptics should never block a UI action. */
  }
}

// Recording moments (start/pause/stop) — stronger Medium tap on a confirmed start, Light otherwise.
export async function recordHaptic(strong = false): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await Haptics.impact({ style: strong ? ImpactStyle.Medium : ImpactStyle.Light });
  } catch {
    /* Haptics should never block a UI action. */
  }
}
