/// <reference types="@capacitor/keyboard" />

import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize, KeyboardStyle } from "@capacitor/keyboard";

// Prod builds set SUTRA_PROD=1 (the shipped app talks to https://api|proxy.rekvon.in). Dev/USB stays
// on http+cleartext so the local proxy over `adb reverse` works without a mixed-content block.
const isProd = process.env.SUTRA_PROD === "1";

const config: CapacitorConfig = {
  appId: "app.sutra.memory",
  appName: "Sutra",
  webDir: "dist",
  // DEV (default): "http" so the WebView origin (http://localhost) shares scheme with the local proxy
  // over `adb reverse`. localhost is still a secure context, so getUserMedia/crypto.subtle keep working.
  // PRODUCTION (SUTRA_PROD=1): "https" WebView origin, no cleartext — talks to the remote HTTPS backend.
  server: isProd ? { androidScheme: "https" } : { androidScheme: "http", cleartext: true },
  android: { allowMixedContent: !isProd },
  plugins: {
    CapacitorSQLite: {
      androidIsEncryption: true,
      androidBiometric: { biometricAuth: false },
      iosDatabaseLocation: "Library/CapacitorDatabase",
      iosIsEncryption: true,
      iosKeychainPrefix: "sutra",
      iosBiometric: { biometricAuth: false },
    },
    Keyboard: {
      resize: KeyboardResize.Body,
      style: KeyboardStyle.Default,
      resizeOnFullScreen: true,
    },
  },
};

export default config;
