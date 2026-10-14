# Sutra — Online-Meeting Capture (Desktop/Web) — Design Spec

**Status:** proposed · **Date:** 2026-06-25 · **Decision:** web-first PWA (Chrome/Edge), no desktop wrapper for v1.

## 1. Problem & goal
In-person meetings: the phone captures fine. **Online/laptop meetings (Meet/Zoom/Teams) are the gap** — putting the phone near the laptop loses audio, and a participant speaking softly through the laptop/headphones isn't heard. We want the user to open Sutra **in the browser (or later a desktop app)**, hit record, and capture the meeting directly from the machine: **their mic + the other participants' audio**, including when output is on **headphones/earbuds**.

## 2. Core capture model — two channels (the big win)
Capture **two separate channels**, never a single mix:
- **Channel 0 = microphone = "Me"** (the device owner — deterministic, no clustering needed).
- **Channel 1 = system/tab audio = all remote participants** (one mixed stream).

This turns the hardest part of diarization ("is this Me or a remote?") into a **channel-index lookup**. Voiceprint clustering is then only needed to *name the remotes* on channel 1 — which is where it actually adds value.

## 3. The headphones question — solved
Browser/OS audio capture taps the **digital stream before the output device**, so speakers vs headphones vs AirPods vs Bluetooth is **irrelevant to capture**. Headphones are in fact the *ideal* case: no acoustic bleed, two pristine channels.

## 4. Web-first decision (and why a desktop wrapper is NOT v1)
The reason to consider Electron was never "users on old browsers" (that's moot — assume latest). The real, version-independent facts:
- **Safari & Firefox capture zero system audio**, every version (engine limit). → gate to **Chrome/Edge**.
- **Where the meeting runs matters more than the browser** (see §5).
- Pure-web on **Chrome/Edge covers the common case** and ships fast.

→ **Build web-first.** Add a desktop wrapper later **only if** real usage needs native-app reliability, Safari/Firefox users, or a frictionless one-tap capture (Phase 2, §10).

## 5. Two capture modes (auto-detected, both pure-web on Chrome/Edge)
| | **Mode A — browser-tab meeting** (Google Meet, web Zoom/Teams) | **Mode B — desktop-app meeting** (Zoom/Teams app) |
|---|---|---|
| Remote audio source | **Tab audio** (`getDisplayMedia`, share the meeting tab) | **System audio** (`getDisplayMedia`, share whole screen) |
| Checkbox | "Share tab audio" (preselected) | "Share system audio" (off by default — must tick) |
| macOS support | Chrome/Edge, all recent | **Chrome 141+ / macOS 14.2+** only |
| Friction | Low (pick tab) | Higher (whole-screen share + checkbox) |
| Reliability | High | Medium (silent no-audio if checkbox missed) |

Mic is always `getUserMedia`. **Mode A is the clean path**; Mode B works but carries the whole-screen-share + missed-checkbox risk.

## 6. Echo / bleed policy (no-headphones case)
Detect output device:
- **Headphones** → no acoustic bleed. Set `echoCancellation:false` on the mic (pristine "Me").
- **Speakers** → mic would re-record remote voices. Set `echoCancellation:true` on the mic **and** `suppressLocalAudioPlayback:true` on the system-capture track (kills the acoustic source). Note AEC needs ~2–5s to converge, so the first window after start is most echo-exposed.

## 7. Encoding (Web Audio API)
1. `micStream = getUserMedia({audio:{echoCancellation, noiseSuppression, autoGainControl}})`.
2. `sysStream = getDisplayMedia({video:true, audio:{systemAudio:'include', suppressLocalAudioPlayback:true}})`. **Guard: if `sysStream.getAudioTracks().length === 0` → user skipped the audio checkbox; prompt to re-share.**
3. One shared `AudioContext({sampleRate:48000})` (forces a common rate → no alignment bugs).
4. `ChannelMerger(2)`: mic → ch0 (L), system → ch1 (R). `AudioWorklet` emits interleaved **linear16 PCM, 2-channel**.
5. Drop the mandatory video track; record audio only.

## 8. Pipeline into Sutra (audio-never-stored, 90s windows)
```
mic (Me) ─┐                              ~90s in-RAM ring buffer (NEVER persisted)
          ├─ AudioContext 48k → ChannelMerger(2) → AudioWorklet → stereo PCM ──► window N
system ───┘   (suppressLocalAudioPlayback)                                        │ in-flight only
                                                                                  ▼
   ROUTER per window (language/provider):
   • Deepgram (default/English): POST stereo, multichannel=true & diarize=true,
       model=nova-3, encoding=linear16, sample_rate=48000, channels=2
       → channels[0]=Me (ignore its speaker label) ; channels[1]=remotes (diarize 0/1/2…)
   • Sarvam (Hinglish): SPLIT stereo → 2 mono 16k PCM (input_audio_codec=pcm_s16le),
       req A=mic→"Me", req B=system→remotes  (Sarvam merges channels, so never send stereo)
                                                                                  ▼
   ATTRIBUTION: ch0 → "Me" (deterministic) ; ch1 → ECAPA voiceprint clustering for stable
                cross-window remote identities → Sutra people/graph. Audio already discarded.
```
The two-channel split happens **before upload, in-flight** — adds zero persistence, preserves the audio-never-stored invariant.

## 9. Provider parameters
**Deepgram (default):** `model=nova-3 multichannel=true diarize=true encoding=linear16 sample_rate=48000 channels=2`. `channels=2` is REQUIRED for raw stereo. Channel 0 = Me; diarize labels meaningful only on channel 1.
**Sarvam (Hinglish):** it **merges channels to mono**, so split client-side into 2 mono 16 kHz PCM requests (`input_audio_codec=pcm_s16le`); req A = "Me", req B = remotes. Intra-remote diarization via Sarvam Batch or ECAPA.

## 10. Phase plan
**Phase 1 — Web (Chrome/Edge PWA):** mode-A/B auto-detect, two-channel capture, echo policy, 90s windows → existing `/transcribe` with `multichannel`, attribution (Me + ECAPA remotes). Browser-gate Safari/Firefox/mobile with a clear "use Chrome/Edge" message. **Ship this.**
**Phase 2 — Desktop wrapper (ONLY if usage demands):** Tauri + Rust (lighter than Electron), **driver-free native loopback** — ScreenCaptureKit / CoreAudio process taps (macOS 14.2+), WASAPI loopback (Windows), PipeWire/Pulse monitor (Linux). Unlocks Safari/Firefox users, reliable native-app capture, and frictionless audio-only one-tap (no screen-picker). **Reference (study/fork the MIT capture crate):** `fastrepl/anarlog` `audio-actual`; minimal example `thewh1teagle/vibe`. **Avoid for code reuse:** screenpipe (commercial license), OBS/BlackHole (GPL), Amurex (AGPL) — technique only.

## 11. Risks / open items
- **Android WebView:** `getDisplayMedia` system-audio is restricted on Android → the phone build would need a native `MediaProjection` bridge for this feature. Web/PWA path is desktop-browser first.
- **Mode B on macOS** needs Chrome 141 + macOS 14.2 — degrade gracefully (offer Mode A or flag unsupported).
- **Silent no-audio** (missed "share audio" checkbox) → hard guard + re-prompt (don't let "audio is gone" return).
- **OPEN INPUT:** are meetings primarily **browser-tab (Meet/web Zoom)** or **desktop-app (Zoom/Teams app)**? Browser-tab → Phase 1 fully covers it. Desktop-app → Phase 1 works via whole-screen-share, and strengthens the Phase-2 case.

## 12. What we reuse from Sutra today
Provider abstraction + `multichannel`/`diarize` params (Deepgram already integrated), the 90s-window + audio-never-stored capture model, ECAPA voiceprint clustering for remote naming, and the existing `/transcribe` proxy. This is a **new capture surface**, not a pipeline rewrite.
