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
| Background mic, screen-off | Keeps listening with the screen off via a native foreground service — hardened so audio flushes incrementally (chunked recording), voice-activity detection no longer depends on a foreground-only animation loop, and turning the screen off force-saves the current window. | Partial (Android native; browser/PWA is foreground-only) |
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
| Self-healing recovery | A conversation interrupted mid-processing is finished automatically on next launch, and a failed/interrupted conversation can be re-run on demand via a "Retry processing" button in its detail view. | Live |
| Capture mode: Hybrid | Best-accuracy processing with audio used in-flight only. | Live (default) |
| Hardenable processing proxy | The cloud-assist proxy can optionally require a shared secret, lock CORS to allowed origins, and cap upload size for safe hosting — all off by default so local/USB use is unchanged. | Live (opt-in) |

## 8. Setup & control
| Feature | What it does | Status |
|---|---|---|
| Guided onboarding | First-run: welcome, privacy, capture mode, language. | Live |
| People management | Enroll, name, and delete people. | Live |
| Opt-in on-device training data | Your text corrections become private training labels, stored on-device only. The audio-retention opt-in is currently disabled/hidden — audio is never persisted by default. | Partial (text only; audio training disabled) |
| Training export / wipe | Export captured data as standard files, or wipe it instantly. | Live |
| Settings | Privacy, language, ranking, recap, people, sessions — all configurable and editable live. | Live |

## 9. Minutes, cleanup & redaction
| Feature | What it does | Status |
|---|---|---|
| Meeting minutes | Auto-generated for meetings (plus on-demand for any conversation); share/export as Markdown. | Live |
| Transcript cleanup (corrector, not author) | A cleaned `text_clean` is produced alongside the raw transcript, with 1:1 / Devanagari / length guards — the raw is always recoverable. | Live |
| Redaction | Redacted turns are excluded from every external surface (export, MCP, sync). | Live |

## 10. Your Context (personal priors)
| Feature | What it does | Status |
|---|---|---|
| Standing beliefs about people/projects/role | Rule-based priors derived from your own history, used as *defeasible defaults* (never authoritative), with confidence decay over time. | Live |
| Your Context editor | Review and edit priors in Settings. | Live |
| Per-prior cloud sharing | Each prior has its own `share_cloud` toggle, **default OFF** — priors stay on-device unless you opt one in. | Live |

## 11. Connect your AI tools (local MCP — "External access")
> **No separate cloud account or hosting** for this path — the app connects out to an MCP server on your own computer over a token-paired WebSocket; redaction/whitelisting is enforced on the phone. See [`../mcp-server/README.md`](../mcp-server/README.md).

| Feature | What it does | Status |
|---|---|---|
| 10 read-only memory tools | search_memory, get_conversation, list_conversations, list_people, get_graph_neighborhood, list_action_items, upcoming_events, get_minutes, get_your_context, ask_memory — usable from Claude Desktop/Code, Cursor, any MCP client. | Live |
| Pairing token + mutual auth | Reveal/copy/rotate a token in Settings; default-deny (`mcp_enabled` OFF), re-checked every request. | Live |
| Per-scope sharing toggles | Independently allow/deny Transcripts, People, Graph, Your Context. | Live |
| Privacy enforcement | No voiceprints/embeddings/draft bodies/redacted turns/tokens ever leave; graph evidence stripped of turn ids. | Live |

## 12. Cloud sync & always-on access (Tier B — explicit opt-in)
> **Off by default.** Honest copy: not "private" — *"stored on our servers so you can reach it anywhere; only you, signed in, can access it."* Code is built and tested; a public HTTPS deployment is the remaining step.

| Feature | What it does | Status |
|---|---|---|
| Account + sync | Email/password (JWT); one-way phone→server push of a `share_cloud`-respecting projection. | Live (needs a host) |
| Hosted MCP endpoint | The same 10 read tools at `/mcp`, scoped to the signed-in user, reachable when your phone is off. | Live (needs a host) |
| AI write-back during chat | add_fact, correct_fact (supersede, never destroy), add_action_item, update_action_item, relabel_person — each behind its own consent toggle (**all default OFF**), every change audit-logged and reversible. | Live (needs a host) |
| OAuth 2.1 connector | PKCE + dynamic client registration for connecting web AI tools. | Live (needs a host) |
| Social sign-in (Google/Facebook) | Scaffolded, env-gated. | Partial (needs provider creds) |

*Verification snapshot: Tier A — 29/29 unit + live E2E (34 assertions) + adversarial review. Tier B — 60/60 pytest + 68/68 live E2E (tenant isolation, write gating, cross-tenant denial, sync survival, full OAuth/PKCE flow); leak scans clean. Engineering contracts: [`archive/MCP.md`](./archive/MCP.md), [`archive/TIER-B.md`](./archive/TIER-B.md), [`archive/YOUR-CONTEXT.md`](./archive/YOUR-CONTEXT.md).*

---

## Honesty guardrails (what is **not** built yet)
So nobody over-promises (for marketing copy especially):

- **No hardware wearable.** Phone app only (Android + web). No pendant/earbud.
- **On-device AI compute is roadmap.** Today's intelligence uses a privacy-preserving cloud-assisted path (audio in-flight only). What's local today is **storage, search, graph, recaps, and the privacy guarantee** — not the AI compute. The "On-device" capture mode is a disabled stub.
- **Speaker-ID / voiceprints require hybrid mode** (the cloud-assisted path). They no-op in a pure on-device mode.
- **Not universal always-on listening.** Screen-off capture is an Android-native capability; plain web/PWA is foreground-only.
- **No live word-by-word diarization** — turns appear per processed chunk.
- **No live calendar/email/Slack integrations**, and emails/drafts are never auto-sent.
- **Single-user, local-trust model** — a free account is required (for hosted cloud-assist + optional sync), but there are no teams or shared memory.
- **A few Settings are placeholders** (auto-drop unknown speakers; per-device model overrides) — visible but disabled.
- **Audio training is off.** Only text corrections can become on-device training labels; the "keep audio for training" opt-in is currently hidden/disabled, so audio is never persisted.

---

*Reliability note: the capture→memory pipeline is built to not lose data — uploads drain deterministically before processing, network calls have timeouts, segmentation/extraction are idempotent and re-runnable, and incomplete recordings are recovered on launch.*
