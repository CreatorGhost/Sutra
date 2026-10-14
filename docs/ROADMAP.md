# Sutra — Roadmap

> What we're planning to build, roughly in priority order. See [`FEATURES.md`](./FEATURES.md) for what already exists and [`OVERVIEW.md`](./OVERVIEW.md) for the why.
>
> This is directional, not a commitment of dates. *(model/vendor names deliberately omitted.)*

---

## Now — finish & harden the core loop
The immediate target is making **capture → memory → recall** dependable and effortless on a real phone.

- **On-device verification pass** — confirm transcription, speaker-ID, events, and recovery all work on the device with real Hinglish conversations (not just in dev).
- **Reliability polish** — *substantially done:* processing failures now surface clearly with an on-demand "Retry processing" action, interrupted recordings are recovered (automatically on next launch and via retry), and screen-off capture is hardened (incremental flushing, robust voice-activity detection, force-save on screen-off). *Remaining:* auto-pause capture when the network drops (since audio can't be stored).
- **On-device unit tests** — add test coverage for the local data, segmentation, and search code so the on-device pipeline is verified, not just spot-checked.
- **Speaker-ID tuning on real voices** — refine the voiceprint clustering/match thresholds against real recordings; make "name once, recognized later" feel reliable.
- **Accuracy of extraction** — keep tightening summaries, action items, decisions, and event date/time resolution, especially for code-switched speech.
- **iOS port build-out** — the iOS Capacitor target is scaffolded but not build-validated: install CocoaPods + `pod install`, set signing and build to device; write the iOS background-audio plugin (`AVAudioSession`/`AVAudioEngine`, `UIBackgroundModes=audio`) since the Android foreground-service capture is Android-only; document the iOS proxy workflow (LAN IP or HTTPS tunnel — no `adb reverse`); add a first-run mic pre-permission screen and formalize the always-listening privacy policy for App Review. *(Details: [`archive/BUILD-HISTORY.md`](./archive/BUILD-HISTORY.md) §6.)*

## Next — make it feel finished
- **UX & accessibility pass** — desktop/large-screen layout, light-theme toggle, full reduced-motion + screen-reader polish, consistent spacing/typography tokens.
- **Better recall** — smarter ranking, filters (by person/topic/date), and saved/asked questions.
- **People & consent** — richer people profiles; **consent mode** to auto-redact or drop turns from unenrolled speakers (the privacy-respectful "only keep people who opted in" behavior).
- **Calendar & light integrations** — turn scheduled events and action items into real calendar entries / reminders; export to the tools you already use. (Read-first, privacy-preserving.)
- **Production transport hardening** — flip the dev transport (cleartext HTTP, USB-only) to HTTPS for production builds, so cloud-assist traffic is encrypted end-to-end off the local link.
- **Launch/ops checklist** — before a real launch: rotate the cloud-assist API key if the working folder was ever shared, and verify the configured language/speech services are actually available on that key.

## Later — the bigger bets
- **Fully on-device AI compute** — move transcription, extraction, and embeddings onto the device so even the *processing* (not just storage) never touches a network. This is the natural endgame of the privacy promise. *(Currently gated by on-device model feasibility on phones.)*
- **More Indian languages & dialects** — extend first-class handling beyond Hindi/Hinglish (Tamil-English, Marathi-Hindi, Bengali-English, etc.).
- **Proactive memory** — gentle, on-device nudges ("you said you'd send X by 5pm"), daily/weekly briefings that anticipate rather than just summarize.
- **"Your context" personalization** — use your own history as priors (not truth) to disambiguate names/entities and improve extraction, with validity windows and decay so stale facts don't mislead.
- **Portability & backup** — encrypted, user-controlled backup/restore and cross-device sync that preserves the local-first, you-own-it model.

## Exploratory — not committed
- **A dedicated capture device / wearable** — only if and when the software loop is excellent. The phone-first app comes first.
- **Team / shared memory** — multi-user is explicitly out of scope today; would require a different trust and consent model.

---

## Guardrails for every roadmap item
Anything we add must keep the non-negotiables intact:
1. **Raw audio is never persisted.**
2. **Local-first; the user owns and can export/wipe their data.**
3. **Hinglish / code-switching stays first-class.**
4. **Honest by default** — cited answers, clear "now vs. later," no silent no-ops.

If a feature can't be built within those, it doesn't ship.
