# Sutra — Implemented Features

> Everything that exists in the app **today**, grounded in the codebase. See [`OVERVIEW.md`](./OVERVIEW.md) for the vision and [`ROADMAP.md`](./ROADMAP.md) for what's next.
>
> **Status legend:** **Live** = works fully · **Partial** = works with a caveat · *(model/vendor names are deliberately omitted)*

---

## 1. Capture
| Feature | What it does | Status |
|---|---|---|
| Tap-to-listen capture | One tap captures a whole conversation hands-free via the phone mic. | Live |
| Smart conversation chunking | Voice-activity detection splits long talks at natural pauses so transcription stays accurate. | Live |
| Pause / resume / end | Full control of a live session. | Live |
| Upload existing audio | Bring in recordings you already have (`.m4a/.mp3/.wav/.webm`). | Live |
| Stays awake while working | Screen wake-lock through recording **and** processing so a lock can't kill a session. | Live |
| Background mic, screen-off | Keeps listening with the screen off via a native foreground service. | Partial (Android native; browser/PWA is foreground-only) |
| Live transcript | Watch turns appear as you talk. | Live |

## 2. Understand who & what was said
| Feature | What it does | Status |
|---|---|---|
| Transcription + speaker separation | See exactly who said what, turn by turn. | Live |
| Voiceprint speaker recognition | Identifies each speaker by voice, keeps them consistent across the whole recording, and can split apart people the transcriber merged. | Live (hybrid mode) |
| "Name once, recognized later" | Name a speaker a single time and they're auto-tagged in future conversations. | Live (hybrid mode) |
| Auto self-introduction tagging | High-confidence "I'm X" intros are labeled automatically. | Live |
| Manual relabeling | Assign or fix any speaker's name inside a conversation. | Live |

## 3. Speaks your language
| Feature | What it does | Status |
|---|---|---|
| Hinglish / code-switching | Reads mixed Hindi–English fluently across transcription, memory, search, and chat. | Live |
| Four ways to write it down | Clean English (auto-translated), Roman Hinglish, Hindi in Devanagari, or exactly-as-spoken verbatim — you choose. | Live |

## 4. Turns talk into memory
| Feature | What it does | Status |
|---|---|---|
| Title + summary | Every conversation gets a clean title and concise summary. | Live |
| Key facts | Durable facts pulled out and listed. | Live |
| Decisions | Explicit decisions captured separately. | Live |
| Action items (owner, due, **steps**) | Tasks surface automatically with who owns them, when they're due, and the ordered sub-steps discussed. | Live |
| Scheduled events (dated) | "kal 11 baje meeting" / "5pm I'll send the files" become real, dated events; resolved against the conversation's date. | Live |
| Upcoming view | Everything coming up, across all conversations, in one place. | Live |
| Importance scoring | The most consequential conversations rise to the top. | Live |

## 5. Connect & recall
| Feature | What it does | Status |
|---|---|---|
| Personal knowledge graph | People, projects, topics, orgs, places, events, and commitments — identified, de-duplicated, and linked, with a sense of change over time. | Live |
| Interactive graph view | A tap-to-explore map of your world. | Live |
| Hybrid search | Find anything by meaning or exact words, ranked by recency and importance. | Live |
| Ask your memory (grounded chat) | Ask questions, get answers sourced from your own conversations **with citations** — and an honest "no record" instead of made-up answers. | Live |
| Tunable ranking | Personalize how memories surface (recency half-life, importance weight). | Live |

## 6. Stay on top of things
| Feature | What it does | Status |
|---|---|---|
| Daily recap | A short daily digest of conversations, highlights, and open actions. | Live |
| Daily notification | A native daily notification at a time you choose. | Live (native; no-op on web) |
| Action-item email draft | One tap turns a task into a polite email draft (you send it). | Live (draft only) |
| Emailed recap | Optional emailed digest. | Partial (needs email/SMTP setup) |

## 7. Yours, and private
| Feature | What it does | Status |
|---|---|---|
| Raw audio never stored | Processed in the moment, then gone — enforced at the data-model level. | Live |
| Encrypted on-device memory | Memory stored in an encrypted on-device database; key held in hardware-backed secure storage. | Live (native; web store is dev-only/unencrypted) |
| Export or wipe | Your data, your call; nothing is auto-uploaded. | Live |
| Works offline | Search, browse, graph, recaps, and people run locally. | Live |
| Self-healing recovery | A conversation interrupted mid-processing is finished automatically on next launch. | Live |
| Capture mode: Hybrid | Best-accuracy processing with audio used in-flight only. | Live (default) |

## 8. Setup & control
| Feature | What it does | Status |
|---|---|---|
| Guided onboarding | First-run: welcome, privacy, capture mode, language. | Live |
| People management | Enroll, name, and delete people. | Live |
| Opt-in on-device training data | Your corrections become private training labels (text and optionally audio), stored on-device only. | Live |
| Training export / wipe | Export captured data as standard files, or wipe it instantly. | Live |
| Settings | Privacy, language, ranking, recap, people, sessions — all configurable and editable live. | Live |

---

## Honesty guardrails (what is **not** built yet)
So nobody over-promises (for marketing copy especially):

- **No hardware wearable.** Phone app only (Android + web). No pendant/earbud.
- **On-device AI compute is roadmap.** Today's intelligence uses a privacy-preserving cloud-assisted path (audio in-flight only). What's local today is **storage, search, graph, recaps, and the privacy guarantee** — not the AI compute. The "On-device" capture mode is a disabled stub.
- **Speaker-ID / voiceprints require hybrid mode** (the cloud-assisted path). They no-op in a pure on-device mode.
- **Not universal always-on listening.** Screen-off capture is an Android-native capability; plain web/PWA is foreground-only.
- **No live word-by-word diarization** — turns appear per processed chunk.
- **No live calendar/email/Slack integrations**, and emails/drafts are never auto-sent.
- **Single-user, local-trust model** — no accounts, teams, or shared memory.
- **A few Settings are placeholders** (auto-drop unknown speakers; per-device model overrides) — visible but disabled.

---

*Reliability note: the capture→memory pipeline is built to not lose data — uploads drain deterministically before processing, network calls have timeouts, segmentation/extraction are idempotent and re-runnable, and incomplete recordings are recovered on launch.*
