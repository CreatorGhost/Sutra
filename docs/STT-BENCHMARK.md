# Sutra STT Provider Benchmark — Metrics Schema & Scorecard

**Date:** 2026-06-25 · **Engines:** OpenAI `gpt-4o-transcribe-diarize` · Deepgram `nova-3` (multi) · Sarvam `saaras:v3` (translate)
**Method:** identical audio through the real `app/providers/stt.py` code; ≤28s clip for the 3-way (Sarvam sync cap) + full file (Deepgram/OpenAI native, all three via auto-chunker).

## 1. Samples

| id | file | duration | profile |
|----|------|----------|---------|
| S1 | Aur.m4a | 216s (3.6m) | English-leaning Hinglish |
| S2 | Blip 260622 | 489s (8.2m) | heavy Hindi, tech terms in English |
| S3 | Blip 260625 | 1428s (23.8m) | heavy Hindi, tech terms in English |

## 2. Metric schema (what we measure)

| metric | unit | source | direction |
|--------|------|--------|-----------|
| `works` | bool | measured | — |
| `latency_realtime_factor` | × (audio_sec / wall_sec) | measured | higher = faster |
| `diarization_speakers` | count | measured | presence = better |
| `devanagari_leak` | chars in output | measured | lower = cleaner English |
| `english_output` | native / needs-step / leaks | measured | native best |
| `techterm_accuracy` | qualitative | measured | — |
| `max_native_len` | seconds before provider rejects | documented | higher better |
| `cost_per_min` | USD or INR | documented / *est | lower better |
| `free_credit` | currency → hours | documented | higher better |

## 3. Raw measured data

| metric | OpenAI | Deepgram | Sarvam |
|--------|--------|----------|--------|
| works (all samples) | ⚠️ (400 on >23min raw) | ✅ | ✅ |
| latency RTF (full file) | ~2.4× | **~47–80×** | ~18× (chunked) |
| latency (28s clip) | 12–17s | 2.5–3.6s | **1.2–2.7s** |
| diarization speakers (S3 full) | 3 | **4** | 0 (sync) |
| devanagari leak (S2/S3 full) | 3619 / 2439 | 2155 / 5265 | **0 / 0** |
| english output | leaks + inconsistent | needs downstream translate | **native (translate)** |
| techterm accuracy (UAT/DB/nectar) | ❌ `U_V_T_`,`D_V_` | ✅ (nectar→vector 1×) | ✅ all correct |
| max native length | ~23min / 25MB | ~unlimited (2GB) | 30s (sync) |
| cost / min | ~$0.006 *est | $0.0112 (multi+diarize) | ₹0.50 (~$0.006) |
| free credit | none | **$200 (~298h)** | ₹100 (~133min) **[EXHAUSTED]** |

> Note: every engine now handles **any length** in Sutra via the `audio_chunk.py` auto-chunker (OpenAI 10-min windows, Sarvam 28s, Deepgram 30-min) — the `max native length` row is the *raw* limit before chunking.

## 4. Decision rubric (how we pick "better")

Weighted score: each dimension scored **0–5**, × weight, summed (max 5.0). Weights reflect Sutra's priorities — a privacy-first ambient **memory** app whose core value is clean, searchable English of Hinglish meetings, with who-said-what.

| dimension | weight | why this weight |
|-----------|--------|-----------------|
| text quality (Hinglish→English) | 0.35 | the product *is* readable/searchable memory |
| diarization (who-said-what) | 0.25 | core promise; drives the voiceprint pipeline |
| long-form reliability | 0.15 | all-day ambient capture |
| speed | 0.10 | perceived responsiveness |
| cost & free runway | 0.10 | unit economics + testing headroom |
| operational fit (streaming/SDK) | 0.05 | integration effort |

## 5. Weighted scorecard

| dimension (weight) | OpenAI | Deepgram | Sarvam |
|--------------------|:------:|:--------:|:------:|
| text quality (0.35) | 1 | 3 | **5** |
| diarization (0.25) | 3 | **5** | 1 |
| long-form (0.15) | 3 | **5** | 3 |
| speed (0.10) | 1 | **5** | 4 |
| cost/runway (0.10) | 2 | **5** | 3 |
| ops fit (0.05) | 3 | **5** | 3 |
| **WEIGHTED TOTAL** | **2.00** | **4.30** | **3.30** |
| **RANK** | 3rd | **1st** | 2nd |

## 6. Verdict

- **Deepgram 4.30 / 5 → 1st (today).** Best system: diarization + speed + long-form + $200 runway. Only gap (Devanagari) is closed by Sutra's existing translate step.
- **Sarvam 3.30 / 5 → 2nd.** Best *text* by far (clean English, 0 leak, tech terms perfect) but sync = no diarization. Highest ceiling.
- **OpenAI 2.00 / 5 → 3rd.** Garbles acronyms on heavy Hindi, slowest (~2.4× RT), raw-rejects long files. Retire from STT.

### Scenario: after wiring Sarvam Batch API (async diarization + long files)

| dimension | Sarvam (sync, today) | Sarvam (Batch) |
|-----------|:--:|:--:|
| diarization | 1 | 4 |
| long-form | 3 | 4 |
| ops fit | 3 | 4 |
| **WEIGHTED TOTAL** | **3.30** | **4.25** |

→ Sarvam-Batch ≈ Deepgram (4.25 vs 4.30), and **overtakes** if you weight text quality higher (Sutra is text-first). So: **ship Deepgram now; build Sarvam Batch as the quality play; re-score.**

## 7. Operational notes
- Sarvam ₹100 free credit **exhausted** during testing (402) — top up to continue live Sarvam runs.
- Auto-chunker validated: gracefully windowed an 8.2-min file into 21 windows and degraded cleanly on per-window API failure.
- Keys live in `backend/.env` (gitignored); both exposed in chat → rotate.
