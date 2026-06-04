# Sutra — Overview

> What this app is, who it's for, and what we're building toward.
> Companion docs: [`FEATURES.md`](./FEATURES.md) (what's built) · [`ROADMAP.md`](./ROADMAP.md) (what's next) · [`../PRODUCT.md`](../PRODUCT.md) (marketing brief).
>
> **Note:** these docs intentionally never name the specific AI models/vendors used — that's a competitive detail. Describe the intelligence generically ("advanced speech-to-text," "language AI," "on-device voiceprint matching").

---

## What is Sutra?

**Sutra is a privacy-first, local-first ambient-memory app that turns your real conversations into a searchable, connected personal memory you actually own.**

You tap once; Sutra listens to a conversation, transcribes it and separates who said what, then distills it into durable memory — a title and summary, key facts, decisions, action items with steps, and scheduled events — and links it all into a personal knowledge graph you can search and ask questions of. Everything Sutra remembers lives **encrypted on your own device**, and your **raw audio is never stored** — it's processed in the moment and discarded. And it's built for how people in India actually talk, treating **Hindi–English (Hinglish) code-switching as a first-class language**, not an afterthought.

It is a **phone app today** (Android, plus a web/PWA build) — not a hardware wearable.

---

## The problem

Your real work, decisions, and commitments happen in conversations — meetings, calls, hallway chats — and almost all of it evaporates. The tools that try to fix this have two problems:

1. **They take your privacy.** Most "AI memory" products record your conversations into *their* cloud, keep the audio, and monetize the data — and several have already been acquired by big tech, turning your most personal recordings into someone else's asset.
2. **They don't speak how you speak.** English-first transcription mangles Hinglish and code-switched speech, so the memory is wrong before it even starts.

Sutra exists to give you the upside (never forget a conversation) without the trade-off (handing over your life).

---

## Principles (the non-negotiables)

1. **Raw audio is never persisted.** Audio is used in-flight only and discarded — the data model has no place to store it. This is enforced in the schema, not just a policy.
2. **Local-first & you own your data.** Derived memory is stored encrypted on your device; you can export or wipe it anytime; nothing is auto-uploaded.
3. **Hinglish is first-class.** The whole pipeline reads mixed Hindi–English fluently, with honest choices for how it's written down.
4. **Honesty over hype.** Answers cite their sources and say "I don't have a record" instead of inventing. The app is clear about what ships now vs. later.
5. **Works offline for what you already have.** Search, browse, graph, recaps, and people all run on-device.

---

## Target audience

**Primary:** conversation-heavy professionals in India and the diaspora —
- **Founders & operators** juggling vendor calls, standups, and decisions.
- **Consultants, sales, account & real-estate folks** who live in client conversations.
- **Students & researchers** capturing lectures, discussions, and study groups.

**What unites them:** they think and work out loud, they switch between English and Hindi/Hinglish (or other Indian languages), and they care about where their data goes.

**Secondary:** privacy-conscious users anywhere who want an ambient "second brain" that doesn't live in someone else's cloud.

**Not the target (today):** enterprise/team shared-memory, multi-user accounts, or anyone who needs an always-on hardware pendant — those aren't what we're building right now.

---

## The north star

> **A second brain that captures every conversation — in your language — that you completely own and can fully trust.**

"Trust" is the whole game: trust that your audio is gone, that your memory is yours, that the answers are grounded, and that it understood what was actually said.

### What we're reaching for (near-term target)

The bar we're driving to right now is a **rock-solid core loop**:

**Capture → understand (accurate transcription + who-said-what) → distill into memory → recall & ask** —

…working **reliably on the phone**, **in Hinglish**, with **speaker recognition that learns people over time**, and the **privacy invariant intact**. When that loop is dependable and feels effortless, Sutra is a product. Everything else (on-device AI compute, richer integrations, a possible wearable) builds on top of that foundation.

---

## How we're different (in one line each)

- **vs. cloud-first memory pendants/apps:** we never keep your audio and your memory never leaves your device.
- **vs. English-first transcription tools:** Hinglish and code-switching are first-class, end to end.
- **vs. "trust us" privacy claims:** the no-audio guarantee is structural, and answers are cited and honest.

(For a deeper competitive picture, see the market notes in the marketing brief.)

---

## Success, defined simply

- A user records a real, messy, bilingual conversation and the memory is **accurate enough to rely on**.
- They can **ask a question weeks later** and get a grounded, cited answer.
- They believe — correctly — that **their audio is gone and their data is theirs**.
- It **just works** on their phone without fiddling.
