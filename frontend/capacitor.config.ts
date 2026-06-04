import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.sutra.memory",
  appName: "Sutra",
  webDir: "dist",
  // DEV: "http" so the WebView origin (http://localhost) shares scheme with the local proxy
  // (http://localhost:8787 via `adb reverse`), avoiding the https->http mixed-content block on
  // fetch(). localhost is still a secure context, so getUserMedia/crypto.subtle keep working.
  // PRODUCTION: set back to "https" — the shipped app talks to a remote HTTPS proxy (no mixed content).
  server: { androidScheme: "http", cleartext: true },
  android: { allowMixedContent: true },
  plugins: {
    CapacitorSQLite: {
      androidIsEncryption: true,
      androidBiometric: { biometricAuth: false },
    },
  },
};

export default config;
