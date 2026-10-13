# Sutra desktop — features and status (October 2026)

Sutra is a desktop meeting-notes app in the style of Aside. It notices your calls, records them without a bot, transcribes and separates speakers on your laptop, and writes notes with the AI you already pay for (Claude Code, Codex, Cursor, Gemini, Grok, Droid or Command Code). No API keys are needed.

Status key: ✅ verified here · 🧪 built and unit-tested, needs a real Mac/Windows run.

## Features

| Area | What you get | Status |
|---|---|---|
| **Meeting detection** | A pill appears when a call starts, e.g. "Google Chrome in call · ● Record", with the real app logo. It stops when the call ends. | 🧪 |
| ↳ how calls are detected | **Windows:** which app is using the mic (registry). **macOS:** which app is using the mic (CoreAudio helper), plus browser meeting tabs, window titles and Zoom's CptHost process. | 🧪 |
| **Recording** | Your mic and the call audio are captured as separate channels, with no bot in the call. Audio is never stored. | ✅ logic · 🧪 on device |
| **Local transcription** | On-device speech-to-text (sherpa-onnx) with models picked for your machine (Qwen3-ASR 0.6B for Hindi/Hinglish, Whisper, Parakeet). Roman or Devanagari Hinglish. | 🧪 (models can't be downloaded in CI) |
| **Speaker separation** | Speakers are separated on device and matched across the whole meeting. Name someone once and they're recognised in later meetings. | 🧪 |
| **Notes** | Brief / Detailed / **Minutes** styles: summary, decisions, action items (tick them off), open questions | ✅ |
| **Ask** | "Ask about this meeting", plus "Ask Sutra" across all meetings, with links to sources | ✅ (with Claude Code) |
| **Projects** | Brief, people with roles, and a glossary of terms with how they're misheard. Meetings are mapped automatically or suggested. | ✅ |
| **Transcript clean-up** | Fixes misheard terms using the project glossary, with a Raw / Cleaned switch | ✅ |
| **Knowledge graph** | People, projects and topics across meetings; click a node to see its meetings | ✅ |
| **Your Context** | Facts Sutra learns about your world: confirm, edit or forget them, and see how fresh each is | ✅ |
| **People** | Rename, "This is me", voice-linked badge | ✅ |
| **AI engines** | Claude Code, Codex, Cursor Agent, Gemini CLI, Grok, Droid, Command Code, with detection of whether each is installed, signed in, and which account and models it has | ✅ Claude end to end · 🧪 others (sign-in errors verified) |
| **MCP** | One-click "Connect" for Claude Code, Codex, Cursor, Gemini CLI and Claude Desktop, so your own agent sessions can read your Sutra memory | ✅ end to end with real MCP clients · 🧪 inside the packaged app |
| **Backup & restore** | Export or import everything as one file (works on desktop and phone) | ✅ |
| **Daily recap** | Desktop notification at the time you choose; on the phone it's a native notification | 🧪 |
| **Accounts / cloud sync** | Hidden on desktop; available in the phone and web app | ✅ |
| **Windows** | Frameless window, tray, pill, notifications, safe handling of npm `.cmd` launchers, and CI on Windows | 🧪 (CI) |

## Where the AI runs
- **Transcription and speaker separation:** always on your computer in the desktop app.
- **Summaries, minutes, clean-up, translation and answers:** your chosen agent CLI. "Auto" uses the first one that's installed and signed in. Each call runs with tools off or a read-only sandbox, in an empty temporary folder, with the prompt sent on stdin.
- **Search:** keywords. Agent CLIs can't produce embeddings.
- **Phone and web:** these builds keep using the Sutra cloud, because there are no local CLIs there.

## Test on your Mac
1. `cd frontend && npm install && npm run dev`.
2. On first run, pick your AI. Then download the recommended transcription model; this also fetches the speaker-separation pack.
3. Join a Google Meet or Zoom call. The pill should appear; click Record, then Stop. Notes should open.
4. **Settings → Connections → Connect Claude Code**, then ask Claude Code about your last meeting.
5. Known unknowns to watch:
   - Some model download links aren't confirmed.
   - Speaker-matching thresholds were tuned for the cloud voiceprints.
   - Cursor, Gemini, Grok, Droid and Command Code output is parsed from documented formats, not tested signed in.
