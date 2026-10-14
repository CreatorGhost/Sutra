# On-device phone: research and plan

Status: research done on 2026-10-14; **nothing built yet**. The open decisions at the end come first.

**Goal.** The phone app works on its own: it transcribes and writes notes on the device, with no Mac and no cloud. Pairing with the Mac stays the "better processing" path. Today the phone records, and the paired Mac (reached through the user's Cloudflare relay) does the transcription and notes.

Several numbers below were **not published anywhere**. They are marked *(unverified)*. Measure them on real devices before committing to a model.

---

## 1. Recommendation

| Job | Android | iOS | Why |
|---|---|---|---|
| **Transcription (default)** | **Qwen3-ASR 0.6B** int8 via sherpa-onnx | same | Same engine and model as the desktop (`frontend/src/shared/speechModels.ts`). It is the only open model that is strong at both English and Hindi/Hinglish, with native language switching. Apache-2.0. About 938 MB on disk; gate to phones with 8 GB RAM or more. |
| Transcription, lower-end phones | Hinglish fine-tuned Whisper (Trelis: CoSHE-500 13.67, cs-fleurs 10.19) | same, or WhisperKit on the Neural Engine | Stock Whisper is weak on Hindi: turbo is about 30 WER on Hindi FLEURS, and large-v3 is 29.7 on CoSHE Hinglish. |
| Hindi-heavy users | IndicConformer 600M multi (AI4Bharat, MIT): Hindi Kathbath 13.5, FLEURS 15.2 | same | Covers 22 Indic languages but is weaker on English. The int8 ONNX export needs a QUInt8 re-export (ConvInteger error on CPU). |
| English-only, fast | Parakeet TDT 0.6B v3 (CC-BY-4.0, needs attribution) or Moonshine (MIT for the English models) | **Apple SpeechTranscriber** (iOS 26): free, no download, LibriSpeech-clean 2.12 | No Hindi in any of these. Hindi in SpeechTranscriber is unconfirmed; check `supportedLocales` on a real device (the Simulator returns nothing). |
| Diarization | sherpa-onnx pipeline, the same as desktop (pyannote-seg-3.0 + 3D-Speaker) | same | Cheap: well under 10% of ASR time (a LiteRT pyannote embedding runs about 1.2 ms per window on a Pixel 8a GPU). The risk on long meetings is under-counting speakers, not speed. |
| **Notes (default)** | **Gemma 4 E2B** int4 on **LiteRT-LM** (GPU), JSON-Schema constrained decoding, map-reduce | same (LiteRT-LM Swift/Metal, or MLX Swift) | Apache-2.0, 2.58 GB, 32K context, Hindi claimed. Measured on a Galaxy S26 Ultra GPU: about 3,800 tok/s prefill and 52 tok/s decode. |
| Notes, larger phones (12 GB+) | Gemma 4 E4B (3.66 GB). Galaxy S26 Ultra GPU: 1,293 / 22 tok/s, decode 46 tok/s with speculative decoding. iPhone 17 Pro: 1,189 / 25 | same | |
| Notes, low-end phones (4–6 GB) | Qwen3.5 0.8B/2B or Llama 3.2 1B on llama.cpp with GBNF; extract decisions and actions only, no minutes | same | Below about 4 GB, show "summarise when paired". |

**Rejected as defaults:**

- **Android Gemini Nano** (AICore / ML Kit GenAI):
  - Input is under 4k tokens.
  - Hindi isn't validated.
  - It runs only while the app is in the foreground (`BACKGROUND_USE_BLOCKED`) and is subject to per-app quotas.
  - It is available only on a short flagship list (Pixel 9–11, Galaxy S26, a few others).
- **Apple Foundation Models:**
  - 4,096 tokens per session, shared between input and output.
  - Hindi is not among its 16 languages.
  - It needs an iPhone 15 Pro or newer.
- Both are fine for English-only meetings on supported phones.

## 2. What it would feel like

- **Phone only.**
  - Transcription runs per ~90 s window *during* the recording, kept alive by the microphone foreground service.
  - On Stop, the phone writes draft notes. Estimated time: about 1–2 minutes on a flagship and 4–7 minutes on mid-range *(unverified)*; about 2–6% of a 5,000 mAh battery *(unverified)*.
  - The first time, it downloads the models on Wi-Fi: about 900 MB for speech and about 2.6 GB for the notes model.
- **Paired.** The Mac does the work, as today. Notes from phone-only meetings are rewritten by the Mac's AI engine when the phone reconnects, and are labelled "Draft" until then.

## 3. Speed and quality evidence

- **Phone ASR speed** is almost unpublished:
  - Whisper base int8 on LiteRT (vivo X300): 12.2× real-time, optimised.
  - Whisper small on a phone CPU: about 0.64–0.90× real-time, so a phone CPU can't batch a 90-minute meeting after the fact.
  - No phone numbers exist for Qwen3-ASR, IndicConformer or Omnilingual (only Mac numbers, e.g. Qwen3 0.6B CoreML int8 RTF 0.098 on an M5 Pro).
  - Estimate for a 0.6B encoder on a Snapdragon 7-series CPU: RTF 0.2–0.5, i.e. 18–45 minutes for a 90-minute meeting if done afterwards *(unverified)*.
  - Expect thermal throttling to roughly halve speed after 10–15 minutes.
- **Notes quality:**
  - Tiny Titans (NAACL 2024, QMSum plus real ASR meetings) found that most models under 2B do not match larger zero-shot LLMs.
  - No 2025–26 on-device meeting-summary evaluation exists.
  - Rough guess *(unverified)*: 70–85% action-item recall compared with a frontier model, with more hallucinated owners.
  - The biggest weakness is Indian names and Hinglish code-mixing. Inject the roster or attendees into every chunk prompt.
- **Notes recipe (map-reduce):**
  1. Split into chunks of about 2.5–3k tokens on speaker-turn boundaries, with about 200 tokens of overlap.
  2. For each chunk, run a constrained-JSON extract `{points[], decisions[], actions[{owner,task}], questions[]}` with at most about 250 output tokens.
  3. De-duplicate actions and owners in code.
  4. Make one reduce pass for the title, summary and minutes.
  5. For Q&A: retrieve chunks, then ask with at most about 3k tokens.

## 4. Integration in this repo

- **Provider seam.** `frontend/src/providers/provider.ts` defines `Provider`. Only `transcribeDiarize(audio: Blob, …)` takes audio; `extract` and `chat` take a schema plus text. Relevant files:
  - `src/providers/ondeviceProvider.ts`: a stub that throws.
  - `src/providers/index.ts` → `resolveProvider`: returns the stub for `mode === "ondevice"` when not paired. Pairing always wins.
  - `src/providers/localSttProvider.ts` → `ComposedProvider`: the template to copy.
  - Target: `ComposedProvider(new PhoneSpeechProvider(model), new PhoneLlmProvider())`, `sttId = "local"`, `canEmbed = false`. Search already falls back to keywords.
  - Also update `isFullTextEngine`; it currently allows `cloud`, `mac` and `agent:*` only.
- **Audio shape.** The phone capture (`src/lib/capture.ts`) produces about 24 kbps Opus windows (ogg/webm). The native side decodes to 16 kHz mono with MediaCodec (Android) or AVAudioConverter (iOS).
- **Plugins.**
  - No maintained Capacitor plugins exist for sherpa-onnx or whisper.cpp.
  - `llama-cpp-capacitor` and `@capgo/capacitor-llm` are immature.
  - `@capacitor/local-llm` is experimental: no JSON schema, 256 output tokens on Android.
  - So write two plugins of our own in Kotlin and Swift:
    - **`SutraSpeech`**: sherpa-onnx ASR + VAD + diarization + embeddings, Opus decoding, model download and management.
    - **`SutraLLM`**: LiteRT-LM (Gemma 4) with JSON Schema; llama.cpp + GBNF fallback.
  - Keep audio off the JS bridge:
    1. JS writes the window to `cacheDir/sutra-audio/<id>.ogg` with `@capacitor/filesystem`.
    2. JS calls `SutraSpeech.transcribe({path, model, language, speakers}) → {jobId}`.
    3. Native code runs it on a worker thread in a foreground service, **deletes the file** (keeping "audio never stored"), and emits `notifyListeners("job", …)` with the existing `Transcription` JSON shape.
  - Existing native code to extend: `android/app/src/main/java/app/sutra/memory/ForegroundMicPlugin.java` and `MicForegroundService.java`.
- **Model delivery.**
  - Use our own HTTPS download with sha256 checks; the catalog already has `sha256?` fields.
  - Make it resumable: WorkManager/DownloadManager on Android, background URLSession on iOS.
  - Store models in Android `filesDir/models` and iOS Application Support, excluded from backup.
  - Default to Wi-Fi only, with a free-space check.
  - Store limits: Play allows 200 MB for the base module, 1.5 GB per asset pack, 4 GB total. App Store On-Demand Resources is being replaced by Background Assets.
- **Background limits.**
  - Android 15+ caps `mediaProcessing` and `dataSync` foreground services at 6 h per 24 h per type, and you must handle `onTimeout()`.
  - iOS 26 `BGContinuedProcessingTask` is user-initiated and reported flaky for 30–60 minute jobs.
  - Hence: transcribe during the recording and make jobs resumable per window.
- **Memory.**
  - Never keep the ASR model and the LLM loaded together on a 6–8 GB phone. Use one native "model host" that holds at most one model and unloads it on `onTrimMemory` / `didReceiveMemoryWarning`.
  - Memory-map the weights.
  - iOS needs the `increased-memory-limit` entitlement.
  - Offer the LLM only on 8 GB+ phones, or use the system model.
- **iOS.** `frontend/ios/App` exists, with `NSMicrophoneUsageDescription` and `UIBackgroundModes: audio`, but no native plugins. It also needs the Swift plugins, BGTask identifiers, the memory entitlement, and a check that SQLite and pairing work on iOS.

## 5. Blocker found along the way

`frontend/android/variables.gradle` sets `targetSdk 34` / `compileSdk 34` (and `minSdk 22`). Since 2026-08-31, Google Play requires API 36 for new apps and updates; an extension to 2026-11-01 is possible. This must be fixed before any Android release, separately from the on-device work.

## 6. Proposed steps

| # | Step | Size |
|---|---|---|
| 0 | Raise Android to API 36 (required regardless) | small |
| 1 | Device bake-off: Qwen3 0.6B vs IndicConformer vs Whisper small vs Hinglish Whisper on one Snapdragon 7-series Android phone and one iPhone, using 30 minutes of real Sutra Hinglish audio. Log WER, RTF, peak RAM and temperature. Run the same for Gemma 4 E2B vs Qwen3.5 2B notes on about 20 meetings, scored against the desktop CLI's notes. | ~2 days, needs the phones |
| 2 | `SutraSpeech` Android plugin plus `PhoneSpeechProvider`; transcribe during recording; model-download UI | large |
| 3 | `SutraLLM` with Gemma 4 E2B map-reduce draft notes, and Mac re-writes the notes on reconnect | large |
| 4 | iOS port of both plugins | large |

## 7. Open decisions (for the owner)

1. Start with steps 0 and 1 (the API-36 fix and the device bake-off), or go straight to step 2?
2. Which test phones are available (model and RAM)? Is there an iPhone, or Android only for now?
3. For phone-only meetings, should the Mac re-do **only the notes** (keeps "audio is never stored"), or also **re-transcribe**? Re-transcribing means keeping the encrypted audio on the phone until it syncs, which changes the audio promise.

## Sources

**ASR**
- Models:
  - [Qwen3-ASR-0.6B](https://huggingface.co/Qwen/Qwen3-ASR-0.6B)
  - [AI4Bharat IndicConformer](https://github.com/AI4Bharat/IndicConformerASR)
  - [IndicConformer int8 ONNX](https://huggingface.co/yashwork-byte/indic-conformer-600m-int8-onnx)
  - [IndicConformer GGUF](https://huggingface.co/Singla0009/IndicConformer-GGUF)
  - [Trelis Tara](https://huggingface.co/Trelis/tara)
  - [whisper-hinglish-preview](https://friendli.ai/models/Trelis/whisper-hinglish-preview)
  - [Moonshine](https://petewarden.com/2026/02/13/announcing-moonshine-voice/)
  - [Omnilingual sizes](https://soniqo.audio/guides/omnilingual)
  - [Sarvam models](https://docs.sarvam.ai/api/getting-started/models)
- Comparisons:
  - [Qwen3 vs Whisper on Hindi](https://whispernotes.app/de/blog/qwen3-asr-vs-whisper)
  - [soniqo Mac benchmarks](https://soniqo.audio/ru/benchmarks/qwen3-asr-vs-whisper)
- Platform recognisers:
  - [Apple SpeechAnalyzer benchmark](https://www.gigazine.net/gsc_news/en/20260714-apple-speech-analyzer-benchmark/)
  - [SpeechTranscriber docs](https://developer.apple.com/documentation/speech/speechtranscriber.md)
  - [Simulator empty locales](https://developer.apple.com/forums/thread/802969)
  - [ML Kit GenAI Speech](https://developers.google.com/ml-kit/genai/speech-recognition/android)
- Phone speed and runtimes:
  - [Arm Whisper base LiteRT](https://developer.arm.com/ai/models/hugging-face/Arm/whisper-base-int8-litert/whisper-base-int8-tflite)
  - [Arm Whisper small](https://developer.arm.com/ai/models/hugging-face/Arm/whisper-small-int8-xnnpack-executorch/whisper-small-int8-pte)
  - [Parakeet on Android](https://soniqo.audio/guides/parakeet/android)
  - [WhisperKit Android](https://www.argmaxinc.com/blog/android)
  - [Qualcomm AI Hub WhisperKit](https://aihub.qualcomm.com/apps/whisper_kit_android)
  - [ExecuTorch](https://pytorch.org/?p=58616)
  - [FluidAudio benchmarks](https://docs.fluidinference.com/reference/benchmarks)
  - [Rust qwen-asr](https://lib.rs/crates/qwen-asr)
- Diarization:
  - [LiteRT diarization](https://huggingface.co/litert-community/Speaker-Diarization-LiteRT)
  - [Picovoice Falcon](https://picovoice.ai/blog/android-speaker-diarization)

**LLM**
- Platform built-ins:
  - [ML Kit GenAI](https://developers.google.com/ml-kit/genai)
  - [Summarization](https://developers.google.com/ml-kit/genai/summarization/android)
  - [Prompt API](https://developers.google.com/ml-kit/genai/prompt/android/get-started)
  - [Prompt API alpha](https://android-developers.googleblog.com/2025/10/ml-kit-genai-prompt-api-alpha-release.html)
  - [Apple TN3193 context window](https://developer.apple.com/tutorials/data/documentation/technotes/tn3193-managing-the-on-device-foundation-model-s-context-window.md)
  - [InfoQ on Apple context](https://infoq.com/news/2026/03/apple-foundation-models-context)
  - [Apple languages](https://support.apple.com/en-us/121115)
  - [Apple forum: unavailable language](https://developer.apple.com/forums/thread/805378)
- Models:
  - [Gemma 4 edge](https://developers.googleblog.com/bring-state-of-the-art-agentic-skills-to-the-edge-with-gemma-4/)
  - [Gemma 4 E4B LiteRT-LM](https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm)
  - [Gemma 4 E2B LiteRT-LM](https://huggingface.co/huggingworld/gemma-4-E2B-it-litert-lm)
  - [Gemma 3n E4B](https://huggingface.co/google/gemma-3n-E4B-it-litert-lm)
  - [Qwen3.5 small](https://gigazine.net/gsc_news/en/20260303-qwen-3-5-small)
- Runtimes:
  - [LiteRT-LM overview](https://ai.google.dev/edge/litert-lm/overview)
  - [LiteRT-LM blog](https://developers.googleblog.com/blazing-fast-on-device-genai-with-litert-lm/)
  - [Cactus](https://infoq.com/news/2025/12/cactus-on-device-inference/)
- Evaluations:
  - [Tiny Titans](https://arxiv.org/html/2402.00841v2)
  - [MILU](https://arxiv.org/abs/2411.02538v3)
  - [voxsum-qwen3.5-0.8b](https://huggingface.co/Luigi/voxsum-qwen35-0.8b)

**Integration**
- sherpa-onnx:
  - [sherpa-onnx releases](https://github.com/k2-fsa/sherpa-onnx/releases)
  - [sherpa-onnx SPM](https://swiftpackageregistry.com/willwade/sherpa-onnx-spm)
  - [react-native-sherpa-onnx](https://github.com/XDcobra/react-native-sherpa-onnx)
- LLM plugins:
  - [llama-cpp-capacitor](https://www.jsdelivr.com/package/npm/llama-cpp-capacitor)
  - [capgo LLM](https://capgo.app/docs/plugins/llm)
  - [@capacitor/local-llm](https://capacitorjs.com/docs/apis/local-llm)
- Store and platform limits:
  - [Play size limits](https://support.google.com/googleplay/android-developer/answer/9859372)
  - [Android FGS timeouts](https://developer.android.com/develop/background-work/services/fg-service-timeout)
  - [iOS 26 background APIs](https://dev.to/arshtechpro/wwdc-2025-ios-26-background-apis-explained-bgcontinuedprocessingtask-changes-everything-9b5)
  - [ODR → Background Assets](https://blakecrosley.com/blog/on-demand-resources-deprecated-background-assets)
