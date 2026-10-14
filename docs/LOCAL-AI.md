# Local AI in Sutra

In the desktop app everything runs on your own computer — nothing goes through the Sutra cloud.
Choose the engines in **Settings → Intelligence** (first launch asks the same questions).

| Job | How it runs on desktop |
|---|---|
| **Transcription + speakers** | Always on this computer: sherpa-onnx in an Electron utility process, with a model picked for your machine (default **Qwen3-ASR 0.6B**). whisper.cpp is an optional extra engine. |
| **Notes, minutes, clean-up, translation, Ask** | The agent CLI you already pay for: **Claude Code**, **Codex**, **Cursor Agent**, **Gemini CLI**, **Grok**, **Droid** or **Command Code**. No API keys. |

On the phone/web app (no agent CLIs there) both run through the Sutra cloud — or, when the phone is
paired with your Mac, through the Mac (see `docs/RELAY.md`).

## Local speech-to-text: models researched

Sutra's quality bar is Hindi–English code-switching (Hinglish), which rules out English-only models as the default.

| Model | Size | Languages | Speed on Apple Silicon | Hinglish | Verdict |
|---|---|---|---|---|---|
| **Whisper large-v3-turbo (q5_0)** | 574 MB | 99 | fast (~6× large-v3) | good | Was the first default; Qwen3-ASR 0.6B (sherpa-onnx) now is. |
| Whisper large-v3-turbo | 1.6 GB | 99 | fast | good | Full-precision Turbo. |
| Whisper large-v3 (q5_0 / full) | 1.1 / 3.1 GB | 99 | slow | best | Most accurate; for Pro/Max chips. |
| Whisper medium / small | 1.5 GB / 488 MB | 99 | medium / very fast | fair / weak | For older machines. |
| Whisper base.en | 148 MB | English | instant | — | Testing only. |
| distil-whisper large-v3 / v3.5 | ~1.5 GB | English | very fast | — | English-only. Not offered. |
| NVIDIA Parakeet TDT 0.6B v2 / v3 | ~1.2 GB | En / 25 European | fastest, top English WER | no Hindi | whisper.cpp gained a `parakeet-cli` (confirmed in its current source), but its output lacks timestamps. It's a candidate for an English-only "fast" option later. |
| NVIDIA Canary 1B / 1B-flash | ~2 GB | En/De/Es/Fr | fast | no | Not a fit. |
| Moonshine tiny / base | 27–60 MB | English | real-time on CPU | no | Good for live captions, not notes. |
| AI4Bharat IndicConformer / IndicWhisper | 0.6–1.5 GB | 22 Indic | medium | strong Hindi | Worth evaluating for Hinglish via sherpa-onnx or NeMo. No whisper.cpp build yet. |

**Runtimes:**
- **sherpa-onnx** — the default (`sherpa-onnx-node`): VAD → speaker diarization (pyannote segmentation + speaker embeddings) → ASR, all in-process. Runs Qwen3-ASR, Whisper, Parakeet and Omnilingual models; no Python.
- **whisper.cpp** — optional (`brew install whisper-cpp`); its ggml models (incl. a Hinglish fine-tune) appear in Settings when `whisper-cli` is installed.
- Not used: MLX-Whisper and faster-whisper (Python), WhisperKit (Swift/CoreML only), transformers.js (slower in the renderer).

**How it runs:**
- Models download on demand into the app's data folder (`~/Library/Application Support/Sutra/sherpa/…` on a Mac). The model list recommends one for your chip and memory.
- Each ~90 s window is transcribed in memory; when an engine needs a file (whisper.cpp), it is a 16 kHz WAV in a private `0700` temp folder, **deleted as soon as the call returns**. Raw audio is never kept.
- Meeting capture keeps **you** (mic) and **everyone else** (call audio) on separate channels; the call channel is diarized into speakers, and per-turn voiceprints keep them consistent across the meeting and later meetings.
- Hindi can be written in Roman (Hinglish) or Devanagari script.

## Agent CLIs for notes and Q&A

Each call runs in a fresh, empty temp folder with tools off (or the agent's read-only mode), one at a
time, with a timeout. The prompt goes on stdin (or the ACP prompt). Replies are checked against the
expected JSON schema, with one retry.

| Agent | How Sutra drives it | Structured output |
|---|---|---|
| Claude Code | `claude -p --output-format json --tools "" --disable-slash-commands --permission-mode dontAsk --no-session-persistence [--model M] --json-schema <schema>` | enforced by the CLI |
| Codex | `codex exec --skip-git-repo-check --ephemeral -s read-only -o <file> [--output-schema <file>] [-m M] -` | enforced by the CLI |
| Gemini CLI | `gemini -p "" --output-format json --approval-mode plan --skip-trust [-m M]` | schema in the prompt, validated |
| Command Code | `command-code -p --output-format json --skip-onboarding --no-auto-update --no-session [--model M]` | schema in the prompt, validated |
| Cursor Agent | **ACP**: `cursor-agent acp` → `initialize` → `authenticate cursor_login` → `session/new` → mode `ask` → model → `session/prompt` | schema in the prompt, validated |
| Grok | **ACP**: `grok agent --no-leader [-m M] stdio` | schema in the prompt, validated |
| Droid | **ACP**: `droid exec --output-format acp` | schema in the prompt, validated |

**Cursor models and context window.** Sutra drives Cursor the way ViewCode does: `initialize` advertises
`clientCapabilities._meta.parameterizedModelPicker`, so the model list is `cursor/list_available_models`
(every model, as bare ids like `claude-opus-5`, with display names), the model is selected by its bare
id, and the context window is set afterwards through the session's `model_config` "Context" option.
The window is the user's choice — **300K (default) or 1M** — in Settings → Intelligence and in the
Ask-bar model picker, for models that offer both. It is saved on the model id in Cursor's own syntax
(`claude-opus-5[context=1m]`), so it follows the model to a paired phone too. A model without a 300K
option (GPT's 272K) gets its nearest window under 300K by default. A Cursor CLI too old for the flag
only accepts the suffixed ids its session lists; Sutra falls back to that form (`resolveAcpModelId`).

- **PATH:** read from your login shell, so CLIs installed with Homebrew, `npm -g` or `~/.local/bin` are found even when Sutra is opened from the Dock. Windows npm `.cmd` launchers are handled without passing text through `cmd.exe`.
- **What the agent does:** extraction (title, summary, decisions, action items, open questions), Detailed notes and Minutes, transcript clean-up (with the project glossary), translation, *Ask about this meeting* and *Ask Sutra*.
- **If the agent fails, everything after transcription stops** (no title, notes or answers) while the transcript itself is fine — check the engine in Settings → Intelligence first.
- **Search:** agents can't produce embeddings, so search is keyword-only (SQLite FTS5).
