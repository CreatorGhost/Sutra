# Local AI in Sutra

In the desktop app you choose, per job, where the work runs: **Settings → Intelligence**. On first launch the Home screen shows the same choices.

| Job | Options |
|---|---|
| **Transcription** (speech-to-text) | **Sutra cloud**: speaker separation, voiceprints, tuned for Hinglish.<br>**On this computer**: whisper.cpp with a model you download. |
| **Notes and questions** | **Sutra cloud**, **Claude Code** (`claude -p`), **Codex** (`codex exec`) or **Cursor Agent** (`cursor-agent -p`). |

## Local speech-to-text: models researched

Sutra's quality bar is Hindi–English code-switching (Hinglish), which rules out English-only models as the default.

| Model | Size | Languages | Speed on Apple Silicon | Hinglish | Verdict |
|---|---|---|---|---|---|
| **Whisper large-v3-turbo (q5_0)** | 574 MB | 99 | fast (~6× large-v3) | good | **Default.** Best balance for a Mac. |
| Whisper large-v3-turbo | 1.6 GB | 99 | fast | good | Full-precision Turbo. |
| Whisper large-v3 (q5_0 / full) | 1.1 / 3.1 GB | 99 | slow | best | Most accurate; for Pro/Max chips. |
| Whisper medium / small | 1.5 GB / 488 MB | 99 | medium / very fast | fair / weak | For older machines. |
| Whisper base.en | 148 MB | English | instant | — | Testing only. |
| distil-whisper large-v3 / v3.5 | ~1.5 GB | English | very fast | — | English-only. Not offered. |
| NVIDIA Parakeet TDT 0.6B v2 / v3 | ~1.2 GB | En / 25 European | fastest, top English WER | no Hindi | whisper.cpp gained a `parakeet-cli` (confirmed in its current source), but its output lacks timestamps. It's a candidate for an English-only "fast" option later. |
| NVIDIA Canary 1B / 1B-flash | ~2 GB | En/De/Es/Fr | fast | no | Not a fit. |
| Moonshine tiny / base | 27–60 MB | English | real-time on CPU | no | Good for live captions, not notes. |
| AI4Bharat IndicConformer / IndicWhisper | 0.6–1.5 GB | 22 Indic | medium | strong Hindi | Worth evaluating for Hinglish via sherpa-onnx or NeMo. No whisper.cpp build yet. |

**Runtimes considered:**
- **whisper.cpp** — chosen. It uses Metal, CUDA and Vulkan, supports quantized models, installs with one command (`brew install whisper-cpp`), and needs no Python.
- **MLX-Whisper** — fastest on M-series, but needs Python.
- **faster-whisper (CTranslate2)** — Python.
- **WhisperKit** — CoreML, Swift only.
- **sherpa-onnx** — runs Parakeet, Moonshine and IndicConformer; the path forward for non-Whisper models.
- **transformers.js** — WebGPU in the renderer; slower and uses more memory.

**How it runs:**
- Models download on demand from `huggingface.co/ggerganov/whisper.cpp` (the official files listed in whisper.cpp's `download-ggml-model.sh`) into `~/Library/Application Support/Sutra/models`.
- Each ~90 s channel window is written as a 16 kHz WAV to a private `0700` temp folder, passed to `whisper-cli -oj`, and **deleted as soon as the call returns**.
- Language choice maps to Whisper flags:

| Transcript language | Whisper flags |
|---|---|
| English | `-l auto -tr` |
| Hindi (Devanagari) | `-l hi` |
| Hinglish | `-l auto`, primed with a romanized sample |

- Whisper has no diarization. Meeting capture already separates **you** (mic) from **everyone else** (call audio). Several remote speakers share one label with local STT; the cloud path splits them by voice.

## Local agents for notes and Q&A

| Agent | Command Sutra runs | Structured output |
|---|---|---|
| Claude Code | `claude -p --output-format json --tools "" --no-session-persistence [--model M] --json-schema <schema>` | enforced by the CLI (`structured_output`) — **verified end to end** |
| Codex CLI | `codex exec --skip-git-repo-check --ephemeral -s read-only -o <file> --output-schema <file> [-m M] -` | enforced by the CLI; flags verified against `codex exec --help` |
| Cursor Agent | `cursor-agent -p --output-format json [--model M] <prompt>` | schema given in the prompt, JSON parsed from the result |

- **Isolation:**
  - Each call runs in a fresh, empty temp folder with tools off or a read-only sandbox.
  - The prompt goes on stdin; Cursor takes it as an argument.
  - Calls are queued one at a time and time out after 4 minutes.
- **PATH:** it's read from your login shell, so CLIs installed with Homebrew, `npm -g` or `~/.local/bin` are found even when Sutra is opened from the Dock.
- **What the agent does:** it runs extraction (title, summary, decisions, action items, open questions), Detailed notes, *Ask about this meeting*, and *Ask Sutra* across meetings.
- **Search:** agents can't produce embeddings, so search is keyword-only (SQLite FTS5) with a local agent.
