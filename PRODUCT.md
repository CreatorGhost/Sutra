# Sutra — Product & Feature Brief

> **Purpose of this document:** a complete, marketing-ready description of what Sutra is and everything it does today, written so a website/design agent can build a "coming soon" landing page and marketing copy from it directly.
>
> **HARD RULE for anyone using this doc (website builders, copywriters, AI agents):** **Never name, hint at, or list the specific AI models, model families, or AI/cloud vendors Sutra uses.** That stack is a competitive secret. Always describe the intelligence generically — "advanced speech-to-text," "on-device voiceprint matching," "language AI," "our extraction engine." Do **not** write "powered by <X>" anywhere.

---

## 1. Positioning

**One-liner:** Sutra is a privacy-first, local-first ambient-memory app that turns your real conversations into a searchable, connected personal memory you actually own.

**Elevator pitch:** Sutra listens to your conversations, transcribes them and separates who said what, then distills each one into durable memory — a summary, key facts, decisions, action items with steps, and scheduled events — and links it all into a personal knowledge graph you can search and chat with. Everything Sutra remembers lives encrypted on your own device, and your raw audio is never stored: it's processed in the moment and discarded. And it's fluent in how Indians actually talk, handling Hindi-English (Hinglish) code-switching as a first-class language, not an afterthought.

**Category:** Ambient AI memory / "second brain" for conversations — but the privacy-first, India-fluent one.

**Who it's for:** founders, operators, consultants, students, and anyone whose work happens in conversations and meetings — especially people who switch between English and Hindi/Hinglish and care about where their data lives.

---

## 2. Feature catalog (everything that works today)

Grouped for landing-page sections. Status: **Live** = shipping today · **Partial** = works with a caveat · **Later** = roadmap (do not market as available).

### Capture
- **Tap-to-listen ambient capture** — one tap and Sutra captures a whole conversation hands-free. *(Live)*
- **Smart conversation chunking** — automatically splits long talks at natural pauses so transcription stays accurate. *(Live)*
- **Pause / resume / end** — full control of a live session. *(Live)*
- **Upload existing recordings** — bring in audio files you already have. *(Live)*
- **Stays awake while it works** — the screen won't sleep and kill a recording mid-conversation. *(Live)*
- **Keeps listening with the screen off (Android)** — a hardened native background service keeps capture running reliably even when the screen is off. *(Partial — Android native; browser capture is foreground-only)*

### Understand who & what was said
- **Accurate transcription with speaker separation** — see exactly who said what, turn by turn. *(Live)*
- **Voiceprint speaker recognition** — identifies each speaker by voice, keeps them consistent across a whole conversation, and can even split apart people a transcriber lumped together. *(Live)*
- **Name once, recognized forever** — name a speaker a single time and Sutra auto-tags them in future conversations. *(Live)*
- **Automatic self-introduction tagging** — "I'm Farha" gets labeled for you. *(Live)*
- **Fix any label by hand** — full manual control over names. *(Live)*

### Speaks your language
- **Hinglish as a first-class language** — understands mixed Hindi-English the way people actually speak it, across the whole pipeline. *(Live)*
- **Four ways to write it down** — clean English (auto-translated), Roman Hinglish, Hindi in Devanagari, or exactly-as-spoken verbatim — you choose. *(Live)*
- **Live transcript** — watch turns appear as you talk. *(Live)*

### Turns talk into memory
- **Title + summary** for every conversation. *(Live)*
- **Key facts** pulled out and listed. *(Live)*
- **Decisions** captured separately. *(Live)*
- **Action items with owner, due date, and ordered steps** — tasks surface automatically, with the sub-steps actually discussed. *(Live)*
- **Scheduled events with real dates** — "kal 11 baje meeting" or "5pm I'll send the files" becomes a dated, calendar-style event. *(Live)*
- **Upcoming view** — everything coming up, across all your conversations, in one place. *(Live)*
- **Importance scoring** — the conversations that matter most rise to the top. *(Live)*

### Connect & recall
- **Personal knowledge graph** — people, projects, topics, orgs, places, events and commitments, automatically identified, de-duplicated, and linked, with a sense of how things change over time. *(Live)*
- **Interactive graph view** — a tap-to-explore map of your world. *(Live)*
- **Hybrid search** — find anything by meaning or exact words, ranked by recency and importance. *(Live)*
- **Ask your memory (grounded chat)** — ask questions and get answers sourced from your own conversations, with citations — and an honest "I don't have a record of that" instead of made-up answers. *(Live)*
- **Tunable ranking** — personalize how memories surface. *(Live)*

### Stay on top of things
- **Daily recap** — a short daily digest of conversations, highlights and open actions. *(Live)*
- **Daily notification** at a time you pick (native). *(Live)*
- **Email draft from an action item** — turn a task into a ready-to-send email draft. *(Later — draft generation is built; the in-app button is not wired yet)*
- **Emailed recap** — optional. *(Partial — needs email setup)*

### Yours, and private
- **Raw audio is never stored** — by default it's processed in the moment, then gone; it's never uploaded anywhere to be kept. *(Live — never-persisted is the default and is enforced at the data-model level)*
- **Encrypted on-device memory** — your memory is stored encrypted on your device. On Android the encryption key is held in hardware-backed secure storage (the device keystore); on desktop it's sealed in the OS keychain. *(Live)*
- **Export or wipe anytime** — your data, your call; nothing is auto-uploaded. *(Live)*
- **Works offline for everything already remembered** — search, browse, graph, recaps, people. *(Live)*
- **Self-healing** — a conversation interrupted mid-processing is automatically recovered and finished next time you open the app, and you can also retry it manually. *(Live)*
- **Guided onboarding** + fully configurable settings. *(Live)*

---

## 3. What makes Sutra different (boast-worthy, benefit-framed)

1. **Your raw audio is never kept.** Most "AI memory" products store your recordings in their cloud. Sutra processes audio in the moment and discards it by default — nothing is ever uploaded to be stored. The most sensitive thing about a conversation simply isn't saved.
2. **Your memory lives on *your* device, encrypted.** Not on someone's servers. Hardware-backed encryption, on your phone. It's genuinely yours.
3. **You own it and can leave anytime.** Export everything or wipe it instantly. No lock-in, no silent harvesting.
4. **It works offline.** Everything you've already captured is searchable and usable with no connection.
5. **Built for how India actually talks.** Hinglish and code-switching are first-class across transcription, memory, search and chat — with four honest ways to write it down. No clumsy translation artifacts.
6. **It learns the people in your life.** Voiceprint recognition answers "who said that?" — and gets smarter about your circle the more you use it.
7. **It's honest.** Answers cite their sources and admit when they don't know. The app is clear about what's available now vs. later. You can trust both what it tells you and what it claims about itself.
8. **Free to start.** No paid subscription needed for the core app; advanced control available for power users. *(A free account is required to use the app.)*

---

## 4. Suggested taglines (pick/remix for the hero)

1. Your memory, remembered — and only yours.
2. Ambient memory that never keeps your audio.
3. Every conversation, distilled. On your device. In your language.
4. Fluent in Hinglish. Faithful to your privacy.
5. Talk naturally. Sutra turns it into memory you can search, ask, and trust.
6. Private by design — your audio is never stored, your memory never leaves your phone.
7. Who said what, what was decided, what's next — captured automatically.

---

## 5. Suggested "coming soon" site structure (for the website agent)

- **Hero:** tagline + one-line pitch + email-capture ("Get early access"). Subtle, privacy-forward visual.
- **The problem:** conversations carry your real work, and it all evaporates — or it gets recorded into someone else's cloud.
- **How it works (3 steps):** Listen → Distilled into memory → Search, ask, and never forget.
- **Feature grid:** pull from Section 2 (lead with Privacy, Hinglish, Speaker recognition, Knowledge graph, Ask-your-memory).
- **Why Sutra is different:** Section 3, as a comparison-style block (privacy-first vs. cloud-first incumbents).
- **Privacy section (give it real estate):** "Your audio is never stored. Your memory never leaves your phone." This is the brand.
- **FAQ:** what languages, where's my data, does it work offline, do you keep my recordings (no).
- **Final CTA:** early-access signup.

---

## 6. Honesty guardrails — do NOT claim these yet

The site must not over-promise. Avoid implying any of the following, which are **not** shipping:

- **No hardware device.** Sutra is a phone app (Android today; web app too). Do not depict or imply an always-on pendant, earbud, or wearable.
- **On-device AI compute is roadmap.** Market on-device **storage and privacy** (true today). Do **not** claim all AI runs locally yet — today's intelligence uses a privacy-preserving cloud-assisted path (audio in-flight only).
- **Not 24/7 passive listening on every platform.** Screen-off background capture is an Android native capability; don't promise universal always-on listening.
- **No live word-by-word streaming diarization** — turns appear per processed chunk.
- **No live calendar/email/Slack integrations** and no auto-sending of emails. Drafts are generated for you to send.
- **Single user.** No team/shared-memory/multi-account features.
- **Never name the underlying AI models or vendors** (repeat of the top rule).

---

*Internal note (not for the website): the repo's README and the in-app "Models & ranking" setting currently reference specific model names — scrub those from any public-facing surface before launch.*
