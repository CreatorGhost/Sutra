> **DRAFT — not legal advice. Requires review by a qualified lawyer before publishing. Placeholders in [BRACKETS] must be filled by the founder.**

# Sutra — Privacy Policy

**Effective date:** [EFFECTIVE DATE]
**Last updated:** [LAST UPDATED DATE]

This Privacy Policy explains how **[COMPANY LEGAL NAME]** ("Sutra," "we," "us," or "our") handles information in connection with the Sutra application ("Sutra" or the "App"). Sutra is a privacy-first, local-first ambient-memory app: it turns your spoken conversations into a searchable, connected personal memory that is stored **encrypted on your own device**.

We've written this policy to match how the App actually works. Where a detail depends on our production deployment or business setup rather than the code, we've marked it in [BRACKETS] for completion before publication.

---

## 1. The short version (summary)

- **Your raw audio is never stored.** It is processed in the moment and then discarded — never written to disk or a database, on your device or on our servers. (See Section 6.)
- **Your memory lives on your device, encrypted.** Transcripts and everything derived from them (summaries, facts, action items, your knowledge graph) are stored in an encrypted database on your phone or computer. (See Section 5.)
- **An account (email + password) is required to use the App.** We store your email, a secure hash of your password, and usage counters tied to your account. (See Sections 3 and 5.)
- **We use third-party AI processing providers** to transcribe and analyze your conversations. Your audio and transcript text are sent to them in-flight for processing; they are contractually intended to process, not retain, this content — subject to their own terms. (See Section 7.)
- **Cloud sync is optional and off by default.** Your memory only leaves your device if you turn on cloud sync, and even then only a filtered copy is uploaded. (See Section 5.4.)
- **You can export your data or delete everything** — your local memory and, separately, your account and any cloud copy — at any time. (See Section 9.)
- **We do not sell your personal information.** As of this draft, the App integrates no third-party advertising, analytics, or behavioral-tracking SDKs.

This summary is for convenience only; the full policy below governs.

---

## 2. Who this policy covers and scope

This policy applies to your use of the Sutra mobile app (Android), the desktop app, and the web/PWA build, together with the backend services that support accounts, cloud-assisted AI processing, and optional cloud sync.

**Note on the web build:** the web/PWA version currently stores its local database **unencrypted** and is intended for development/evaluation only. Do not use the web build for sensitive data. Encrypted on-device storage applies to the Android and desktop apps. [FOUNDER: confirm whether the web build is offered to end users or kept internal.]

---

## 3. Information we collect

### 3.1 Account information
To use Sutra you must create an account. We collect and store on our servers:
- **Email address** (used as your login identifier and for account-related communication).
- **A cryptographic hash of your password** (hashed with Argon2; we never store or log your plaintext password). This applies to email/password accounts.
- **Authentication metadata**: your account identifier, sign-in method (`password`, or a social provider if you use one), and account creation date.
- If you choose to sign in with a **social provider** (e.g., a "Sign in with [Provider]" option, where offered), we receive basic identifying information from that provider as needed to create your account. [FOUNDER: confirm which social providers are enabled at launch and what fields they return.]

### 3.2 Content you capture
When you use Sutra to capture a conversation, the App works with:
- **Audio** — captured from your device microphone (or an audio file you upload). Audio is **processed in-flight and never persisted** (see Section 6).
- **Transcripts** — the text produced from that audio, with speaker turns ("who said what").
- **Derived memory** — the title, summary, key facts, decisions, action items (with owners, due dates, and steps), scheduled events, importance score, meeting minutes, a cleaned-up transcript, and a personal knowledge graph (people, projects, topics, orgs, places, events, commitments and the links between them) that Sutra generates from your transcripts.
- **Voiceprints** — a mathematical voice embedding (a numeric vector, **not** audio) computed in-flight and stored on your device so Sutra can recognize a speaker across conversations. Voiceprints are **never uploaded**, including during cloud sync.
- **People and labels you add** — names you assign to speakers, notes, and corrections.
- **"Your Context" priors** — standing, rule-based defaults Sutra derives about people/projects/your role. Each prior is private to your device unless you individually opt it into cloud sharing.

By default, the audio itself is discarded after processing; the transcripts and derived memory above are stored **encrypted on your device** (see Section 5).

### 3.3 Usage and technical data
Because the App is account-gated and uses cloud-assisted AI processing, our servers record limited operational data tied to your account:
- **Usage metering counters** — for example, seconds of audio transcribed and counts of AI operations (transcription, extraction, chat, embedding, re-ranking) per month. We use these to enforce plan limits and to inform future pricing. These counters are numeric usage records; they do **not** contain your conversation content.
- **Plan / entitlement information** — your current plan and any per-account limits.
- **Technical request data** — when your app or a connected tool contacts our servers, we process standard request metadata (such as IP address) transiently, including for rate-limiting and abuse prevention on sign-in. [FOUNDER: confirm what server/access logs your hosting provider retains and for how long.]
- **Audit records for cloud write-backs** — if you enable optional AI write-back to a synced cloud copy (Section 5.4), each change is recorded in an audit log so it can be reviewed and reversed.

### 3.4 Information we do NOT collect
- We do **not** store your raw audio (Section 6).
- As of this draft, we do **not** embed third-party advertising, analytics, or behavioral-tracking SDKs in the App.
- We do **not** operate teams, sharing, or multi-user features — Sutra is single-user, so there is no social graph or contact-list harvesting.

---

## 4. How we use information

We use the information above to:
- **Provide the core product** — transcribe your conversations, separate speakers, and distill them into memory you can search, browse, and ask questions of.
- **Recognize speakers** — match voiceprints on your device so a person you name once is tagged later.
- **Operate your account** — authenticate you, apply your plan limits, and meter usage.
- **Enable optional features you turn on** — cloud sync, hosted always-on access, connected AI tools, and AI write-back (all off by default).
- **Maintain security and prevent abuse** — for example, rate-limiting sign-in attempts.
- **Communicate with you** — about your account, service changes, and support. [FOUNDER: confirm whether any marketing email is sent; if so, describe opt-out.]
- **Comply with law** and enforce our Terms.

**Legal bases (where GDPR/UK GDPR applies):** performance of our contract with you (providing the App), your consent (for optional features like cloud sync and AI write-back), our legitimate interests (security, abuse prevention, product operation), and compliance with legal obligations. [FOUNDER/COUNSEL: confirm the legal-basis mapping for your target markets.]

---

## 5. Where your data lives and how it's stored

### 5.1 On your device (default)
Your transcripts and all derived memory are stored in a **local database on your device**:
- **Android:** the database is encrypted with SQLCipher. The encryption key is generated on your device by a secure random generator and held in Android Keystore-backed secure storage (hardware-backed where the device supports it). The key is never written into ordinary app storage and never leaves the device.
- **Desktop:** the database is encrypted with the same technology; the key is sealed using your operating system's secure key store (Keychain on macOS, DPAPI on Windows, libsecret on Linux) and only ever exists in memory in the app's main process.
- **Web/PWA:** the local store is **unencrypted** and intended for development only (see Section 2).

Because the Android app disables system auto-backup of this database, your memory does **not** silently sync to a cloud backup — your local **Export** (Section 9) is the intended way to keep a copy.

### 5.2 On our servers — account and usage
We store your **account record** (email, password hash, sign-in method, creation date) and **usage/entitlement data** (Section 3.3) on our servers so the App can be activated and metered. This does **not** include your conversation content.

### 5.3 Cloud-assisted AI processing (in-flight only)
To produce transcripts and memory, the App sends audio and text to our processing service, which relays them to third-party AI processing providers (Section 7). This service is designed to be **content-stateless**: it does not store your audio or text; content is used only to compute a response and is then discarded. It does record the numeric usage counters described in Section 3.3.

### 5.4 Optional cloud sync (off by default)
If — and only if — you turn on **cloud sync**, the App pushes a filtered, one-way copy of your memory from your device to your account on our servers, so you can reach it when your device is off or from connected AI tools. This copy is a **projection**, not a full mirror:
- **Audio is never included** (there is no audio anywhere in the sync data).
- **Voiceprints are never included.**
- **Redacted turns are excluded.**
- **Generated draft message bodies are excluded.**
- **Knowledge-graph evidence is stripped** of turn-level identifiers.
- **"Your Context" priors sync only if you individually mark each one to share** — otherwise they stay on your device.

Re-syncing replaces your prior server projection. This cloud copy is **stored on our servers so you can access it anywhere; it is not end-to-end encrypted, and it is accessible to us as the operator.** We describe it honestly as convenience access, not as a private/zero-knowledge store. You can delete it at any time (Section 9). [FOUNDER: confirm the production cloud-sync service is deployed and reachable only over encrypted (HTTPS/TLS) connections before enabling this feature for users.]

### 5.5 Optional connected AI tools ("External access" / MCP)
Sutra can expose read-only access to your memory to AI tools you run **on your own computer** (e.g., a desktop AI client), over a token-paired local connection. This is off by default, gated by a token you control, and filtered on your device (no voiceprints, embeddings, draft bodies, redacted turns, or tokens are shared). A hosted version of this access exists only if you enable cloud sync/hosted access.

---

## 6. Our core promise: raw audio is never stored

This is the heart of Sutra's design, so we state it precisely:

- When you capture or upload a conversation, the **audio is processed in the moment and then discarded.** It is **not** written to any file or database on your device, and it is **not** stored on our servers.
- In the current cloud-assisted processing mode, audio is **streamed in-flight** to third-party AI processing providers to produce the transcript and to compute voice embeddings for speaker recognition. Our processing service reads that audio only to compute a result and then releases it; it is not saved.
- From that audio we keep only **derived, non-audio data**: the text transcript and a numeric voiceprint vector.
- The **only** mechanism anywhere in the App that could retain audio is an optional, on-device, never-uploaded voice-training feature. **That option is currently disabled/hidden**, so in practice no audio is written anywhere today.

We describe this as audio being "not stored by default" deliberately, rather than as an absolute technical impossibility, so the statement stays honest as the product evolves. What third-party providers do with in-flight audio is governed by their terms (Section 7). [FOUNDER/COUNSEL: confirm each provider's contractual no-retention / zero-data-retention posture and reflect it here.]

---

## 7. Third-party AI processing providers (sub-processors)

Sutra relies on third-party providers to perform speech-to-text, language understanding, extraction, embeddings, and related AI tasks ("AI processing providers"). When you capture a conversation or ask a question of your memory, the relevant audio and/or text is sent to these providers in-flight so they can return a result.

- These providers act as our **processors/sub-processors** and are intended to process content only to deliver the requested result, subject to their own terms and data-processing commitments.
- We do **not** publicly name our specific providers or models. A current list of sub-processors, the categories of data each receives, and the country/region in which each processes data will be maintained here: **[SUB-PROCESSOR LIST — names, purpose, and data location for each]**.
- Advanced users may optionally configure their own AI provider key; in that case, the relevant requests are processed under that user's own account with that provider.

Other service providers we may use include our **cloud hosting/infrastructure provider** and, if configured, an **email delivery provider**. [FOUNDER: list hosting provider + region and any email provider.]

We require, or will require, appropriate data-protection terms with these providers. [FOUNDER/COUNSEL: confirm DPAs / standard contractual clauses are in place with each sub-processor.]

---

## 8. Data sharing and disclosure

We do **not** sell your personal information, and we do **not** share it for cross-context behavioral advertising.

We disclose information only:
- **To the service providers/sub-processors** described in Section 7, to operate the App.
- **When you direct it** — e.g., when you enable cloud sync, connect an AI tool, or generate a draft message that you then choose to send.
- **For legal reasons** — to comply with applicable law, a valid legal request, or to protect the rights, safety, and security of users, the public, or [COMPANY LEGAL NAME].
- **In a business transfer** — if we are involved in a merger, acquisition, or sale of assets, subject to this policy. [FOUNDER/COUNSEL: confirm you want this standard clause.]

---

## 9. Your choices and rights

### 9.1 Controls built into the App
- **Export your data.** You can export your entire local memory to a single file that you keep. (Note: this export file is unencrypted plaintext so you can open it after a reinstall — store it somewhere safe.)
- **Wipe your local memory.** You can clear data on your device from within the App.
- **Delete your account.** Deleting your account is **immediate** and **cascades**: it removes your account record and every server-side row associated with it — any synced memory projection, entitlements, usage counters, audit log, connected-tool grants, and server-side settings. Deleting your account requires a fresh confirmation (your password, or typing your email for social accounts). **Your local on-device memory is not affected by account deletion** — remove it separately using the wipe/export controls.
- **Manage optional features.** Cloud sync, hosted access, connected AI tools, per-prior cloud sharing, and AI write-back consent toggles are all **off by default** and individually controllable in Settings.
- **Correct your data.** You can rename speakers, edit people, correct transcripts, and edit your "Your Context" priors directly in the App.

### 9.2 Statutory rights
Depending on where you live, you may have rights to access, correct, delete, port, or restrict processing of your personal data, to object to certain processing, and to withdraw consent — for example under:
- **India's Digital Personal Data Protection Act, 2023 (DPDP Act)** — including rights to access, correction, and erasure, and the right to grievance redressal.
- **The EU/UK GDPR** — for users in the EEA/UK.
- **The California Consumer Privacy Act / CPRA** — for California residents (note: we do not sell or "share" personal information as those terms are defined).

Because most of your content lives on your own device under your control, many of these rights you can exercise directly in the App (Section 9.1). For rights relating to your account or any cloud copy, contact us at **[CONTACT EMAIL]** and we will respond as required by applicable law. We will not discriminate against you for exercising your rights. [FOUNDER/COUNSEL: confirm response timelines and any identity-verification step.]

---

## 10. Data retention

- **On-device data** is retained on your device until you delete it (via wipe, uninstall where applicable, or import-overwrite). We do not control your device backups.
- **Account data** (email, password hash) is retained for as long as your account exists and is deleted when you delete your account.
- **Server usage counters and audit logs** are retained for **[RETENTION PERIOD — e.g., N months]**. [FOUNDER: define; no automatic purge job for usage/audit data is currently implemented, so a retention/deletion practice must be defined and, ideally, enforced.]
- **Cloud sync projection** (if enabled) is retained until you re-sync (which replaces it) or delete your account/cloud copy.
- **In-flight content** sent to AI processing providers is not retained by our processing service; provider retention is governed by their terms — **[confirm and state provider retention]**.

---

## 11. Security

We take reasonable technical and organizational measures to protect your information, including:
- **Encryption of on-device memory** using SQLCipher with keys held in hardware-backed / OS-level secure storage (Android and desktop; see Section 5.1).
- **Password hashing** with Argon2; plaintext passwords are never stored or logged.
- **Content-stateless processing** — our AI processing service is built not to store your audio or transcripts.
- **Data-minimizing server logs** — account identifiers are logged rather than emails, passwords, or tokens.
- **Rate-limiting** on authentication to resist credential-stuffing.

No method of transmission or storage is completely secure, and we cannot guarantee absolute security. **[FOUNDER: confirm that all production endpoints (accounts, sync, hosted access, and the AI processing service) are served exclusively over HTTPS/TLS. This is essential and must be verified before launch.]**

---

## 12. International data transfers and data residency

Sutra is built for users in India and elsewhere. Because we use third-party AI processing and hosting providers, your in-flight content and (if you enable sync) your cloud projection may be processed in countries outside your own, which may have different data-protection laws.

**[FOUNDER/COUNSEL: confirm the countries/regions where audio/text is processed and where the cloud projection and account data are hosted, and put appropriate transfer safeguards (e.g., standard contractual clauses) in place. India's DPDP Act may impose conditions on cross-border transfers — confirm compliance.]**

---

## 13. Children's privacy

Sutra is not directed to children under **[AGE — e.g., 18 in line with India's DPDP Act, which treats individuals under 18 as children and requires verifiable parental consent]**, and we do not knowingly collect personal data from them. If you believe a child has used Sutra without appropriate consent, contact us at **[CONTACT EMAIL]** and we will take appropriate action. [FOUNDER/COUNSEL: reconcile the age threshold and parental-consent mechanics across DPDP (under 18), GDPR (13–16 per member state), and COPPA (under 13) for your target markets.]

---

## 14. Changes to this policy

We may update this policy from time to time. If we make material changes, we will update the "Last updated" date and, where appropriate or legally required, notify you in the App or by email. Your continued use of Sutra after an update means you accept the revised policy.

---

## 15. Contact us

If you have questions or requests regarding this policy or your data:

- **[COMPANY LEGAL NAME]**
- **Email:** [CONTACT EMAIL]
- **Address:** [COMPANY ADDRESS]
- **Grievance / Data Protection Officer (as applicable under the DPDP Act / GDPR):** [NAME + CONTACT]

[FOUNDER/COUNSEL: India's DPDP Act may require you to publish the contact details of a Data Protection Officer or a designated grievance-redressal contact — confirm and fill in.]
