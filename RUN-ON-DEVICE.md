# Run Sutra live on a physical Android device (Samsung Z Fold 7)

End-to-end: capture a real conversation on the phone → diarized transcript → extraction →
memory → search/chat, **all stored on-device**. Default mode is **Hybrid** (audio goes in-flight to
*your* proxy → OpenAI, never stored; "Audio is processed in the cloud and never stored.").

## 0. Prereqs (on the Mac)
- Repo at `/Users/adityapratapsingh/code/Sutra`, Docker running, Android SDK + adb (`/opt/homebrew/bin/adb`), JDK 21.
- Phone: **Developer Options + USB debugging ON** (Settings → About phone → tap *Build number* 7×; then Settings → Developer options → USB debugging).

## 1. Start the proxy (holds the OpenAI key; audio in-flight only)
```bash
cd /Users/adityapratapsingh/code/Sutra
docker compose up -d proxy            # proxy on :8787 (reuses .env OPENAI_API_KEY)
curl -s localhost:8787/health         # -> {"status":"ok","service":"sutra-proxy",...}
```

## 2. Connect the Z Fold 7 + make the proxy reachable
```bash
# USB-C cable; accept the "Allow USB debugging?" RSA prompt on the phone
adb devices                           # your Fold should show as 'device' (not 'unauthorized')

# EASIEST: tunnel the phone's localhost:8787 -> Mac's proxy over USB (no rebuild needed,
# because the app's default proxy URL is http://localhost:8787)
adb reverse tcp:8787 tcp:8787
```
**ADB over Wi-Fi (nice for a foldable you're holding):**
```bash
adb tcpip 5555                        # while still on USB
adb connect <phone-LAN-IP>:5555       # find IP in Settings → Wi-Fi → (network) → IP
# unplug USB; then re-run:  adb reverse tcp:8787 tcp:8787
```
**Alternative (no adb reverse) — bake the LAN URL in at build time:**
```bash
cd frontend
VITE_PROXY_URL=http://192.168.1.9:8787 npm run build && npx cap sync android
# (proxy already binds 0.0.0.0; phone must be on the same Wi-Fi; allow port 8787 through the Mac firewall)
```

## 3. Build + install + launch
```bash
cd /Users/adityapratapsingh/code/Sutra/frontend
npm run build && npx cap sync android
export ANDROID_HOME=$HOME/Library/Android/sdk
npx cap run android                   # builds, installs, launches on the connected Fold
# --- or install the prebuilt debug APK directly: ---
# cd android && ANDROID_HOME=$HOME/Library/Android/sdk ./gradlew assembleDebug
# adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## 4. On the phone (first run)
1. Allow **Microphone** (prompt on first record) and **Notifications** (Android 13+; needed for the foreground-service notice).
2. **Settings → Battery → Sutra → Unrestricted** — stops Android from throttling the mic foreground service during long/screen-off sessions.
3. Open **Capture** → tap the mic. A persistent **"Sutra is listening · audio is never stored"** notification appears (the mic foreground service).
4. Speak a real Hinglish conversation. Silence gaps cut ~2–5 min windows; each uploads to the proxy → diarized turns appear live.
5. Tap **Stop & process** → extraction runs → open **Memory** (summary, action items, entities), **Graph**, and **Ask** (cited chat). Everything is stored on-device in encrypted SQLite.

## Gotchas (Z Fold 7 specific)
- **Fold/unfold** mid-session is handled (the activity declares the right `configChanges`), so it won't restart/lose state.
- **Screen-off capture** works via the foreground service, but extended screen-off recording should be validated on the device (doze/OEM battery policies vary — "Unrestricted" above is the key setting).
- **Mode:** default **Hybrid** (audio → your proxy, in-flight, not stored). The **on-device "max privacy"** mode ("Audio never leaves your device.") is the Phase-3 stub — not active yet.
- **adb reverse** must be re-applied after each reconnect/reboot of the phone.
- The web SQLite (jeep-sqlite/sql.js wasm) mismatch from the browser preview **does NOT apply on device** — native Android uses real SQLite (SQLCipher).

## Verify data is on-device
- All transcripts/memories/graph/voiceprints live in the app's encrypted SQLite. Uninstalling the app wipes it. Nothing is written to the proxy (stateless) or any server.
