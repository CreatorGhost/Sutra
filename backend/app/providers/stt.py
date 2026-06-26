"""Pluggable speech-to-text layer.

STT is decoupled from the LLM provider: chat/extract/embed/rerank always stay on OpenAI, but
transcription can be routed to OpenAI, Deepgram, Sarvam, or the mock by flipping
``settings.stt_provider`` (env ``STT_PROVIDER`` or the runtime-settings DB row — live, no redeploy).

Every provider returns the SAME normalized contract so nothing downstream changes::

    {"text": str, "duration": float, "segments": [{"speaker", "start", "end", "text"}]}

Audio is handled in-flight ONLY and never persisted — the same invariant as the rest of the proxy.
"""
from __future__ import annotations

import asyncio
import functools
import glob
import json
import logging
import os
import shutil
import tempfile
from typing import Protocol

import httpx

from ..config import get_runtime_settings
from .audio_chunk import _ext, split_stereo_channels, transcribe_chunked
from .mock_provider import MockProvider
from .openai_provider import OpenAIProvider

log = logging.getLogger("sutra.stt")


class SttProvider(Protocol):
    async def transcribe_diarize(
        self, audio: bytes, filename: str, content_type: str, prompt: str | None = None,
        multichannel: bool = False,
    ) -> dict:
        """Return {"text", "duration", "segments":[{speaker,start,end,text}]}. Never persist audio.

        ``multichannel=True`` (online-meeting capture) tags each segment with ``channel`` (0=mic/Me,
        1=remotes) and ``is_me``; channel-0 carries the single owner label "Me"."""
        ...


def _group_words_by_speaker(words: list[dict], owner_label: str | None = None) -> list[dict]:
    """Collapse a Deepgram ``words[]`` list into per-turn segments by consecutive speaker.

    ``owner_label`` (e.g. "Me") forces every emitted segment onto that single speaker, ignoring the
    per-word diarization — used for the mic channel where the owner is known. Pure helper, shared by
    the words-fallback and the per-channel multichannel path."""
    segs: list[dict] = []
    cur: dict | None = None
    for w in words or []:
        spk = owner_label if owner_label is not None else str(w.get("speaker", 0))
        tok = (w.get("punctuated_word") or w.get("word") or "").strip()
        if not tok:
            continue
        if cur is None or cur["speaker"] != spk:
            if cur:
                segs.append(cur)
            cur = {"speaker": spk, "start": float(w.get("start", 0.0) or 0.0),
                   "end": float(w.get("end", 0.0) or 0.0), "text": tok}
        else:
            cur["end"] = float(w.get("end", cur["end"]) or cur["end"])
            cur["text"] = (cur["text"] + " " + tok).strip()
    if cur:
        segs.append(cur)
    return segs


# ── OpenAI ─────────────────────────────────────────────────────────────────────────
class OpenAiStt:
    """Adapter over the existing ``OpenAIProvider.transcribe_diarize``. Auto-chunks audio longer
    than ~10 min so it never hits OpenAI's 25 MB / ~23 min ceiling. Honors an optional per-request
    BYO key (the enterprise power-user path the proxy already had)."""

    MAX_SECONDS = 600   # 10-min windows: ~19 MB as 16 kHz wav, well under the 25 MB cap
    CONCURRENCY = 3

    def __init__(self, byo_key: str | None = None) -> None:
        self._p = OpenAIProvider()
        if byo_key:
            self._p._headers = {"Authorization": f"Bearer {byo_key}"}

    async def _transcribe_one(self, audio, filename, content_type, prompt=None) -> dict:
        return await self._p.transcribe_diarize(audio, filename, content_type, prompt=prompt)

    async def transcribe_diarize(self, audio, filename, content_type, prompt=None, multichannel=False) -> dict:
        # OpenAI has no stereo/multichannel STT, so the flag is accepted (uniform signature) but ignored.
        return await transcribe_chunked(self._transcribe_one, audio, filename, content_type, prompt,
                                        max_seconds=self.MAX_SECONDS, concurrency=self.CONCURRENCY,
                                        label="openai")


# ── Deepgram (Nova-3) ────────────────────────────────────────────────────────────────
class DeepgramStt:
    """Deepgram ``/v1/listen`` (pre-recorded). Streams the raw audio bytes, asks for diarization +
    utterances, and normalizes the utterances into per-turn segments. Deepgram transcribes
    IN-LANGUAGE (it has no native speech-translation), so any Hindi→English step stays downstream
    exactly as today."""

    MAX_SECONDS = 1800   # Deepgram handles 2 GB natively; chunk only very long audio for memory
    CONCURRENCY = 4

    def __init__(self) -> None:
        s = get_runtime_settings()
        self._base = s.deepgram_base_url.rstrip("/")
        self._key = s.deepgram_api_key
        self._model = s.deepgram_model
        self._language = s.deepgram_language
        self._diarize = bool(s.deepgram_diarize)
        if not self._key:
            log.warning("DEEPGRAM_API_KEY missing — Deepgram STT calls will 401.")

    async def transcribe_diarize(self, audio, filename, content_type, prompt=None, multichannel=False) -> dict:
        # Bind the multichannel flag so it survives auto-chunking (transcribe_chunked only passes
        # audio/filename/content_type/prompt to the callable).
        one = functools.partial(self._transcribe_one, multichannel=multichannel)
        return await transcribe_chunked(one, audio, filename, content_type, prompt,
                                        max_seconds=self.MAX_SECONDS, concurrency=self.CONCURRENCY,
                                        label="deepgram")

    def _build_params(self, multichannel: bool = False) -> dict:
        params = {
            "model": self._model,
            "language": self._language,
            "smart_format": "true",
            "punctuate": "true",
            "utterances": "true",  # gives clean per-turn segments with a speaker
        }
        if self._diarize:
            params["diarize"] = "true"
        if multichannel:
            # Online-meeting stereo: ch0=mic/Me, ch1=remotes. `channels=2` is required for raw stereo.
            params["multichannel"] = "true"
            params["channels"] = "2"
        return params

    async def _transcribe_one(self, audio, filename, content_type, prompt=None, multichannel=False) -> dict:
        # `prompt` is OpenAI-style free-text steering; Deepgram has no equivalent, so it is ignored
        # here — language is chosen via the `language` param instead (`multi` = code-switching).
        params = self._build_params(multichannel)
        headers = {
            "Authorization": f"Token {self._key}",
            "Content-Type": content_type or "application/octet-stream",
        }
        log.info("deepgram transcribe: model=%s language=%s diarize=%s",
                 self._model, self._language, self._diarize)
        async with httpx.AsyncClient(base_url=self._base, headers=headers, timeout=600.0) as c:
            resp = await c.post("/v1/listen", params=params, content=audio)
            resp.raise_for_status()
            body = resp.json()
        return self._normalize(body, multichannel=multichannel)

    @staticmethod
    def _normalize(body: dict, multichannel: bool = False) -> dict:
        results = body.get("results") or {}
        channels = results.get("channels") or []
        alt0 = ((channels[0].get("alternatives") or [{}])[0]) if channels else {}
        duration = float((body.get("metadata") or {}).get("duration", 0.0) or 0.0)

        if multichannel:
            return DeepgramStt._normalize_multichannel(channels, duration)

        text = (alt0.get("transcript") or "").strip()
        segs: list[dict] = []
        # Primary source: utterances[] (present with utterances=true) — one turn each, with speaker.
        for u in results.get("utterances") or []:
            t = (u.get("transcript") or "").strip()
            if not t:
                continue
            segs.append(
                {
                    "speaker": str(u.get("speaker", 0)),
                    "start": float(u.get("start", 0.0) or 0.0),
                    "end": float(u.get("end", 0.0) or 0.0),
                    "text": t,
                }
            )
        # Fallback: group words[] by consecutive speaker (diarize on, utterances off).
        if not segs:
            segs = _group_words_by_speaker(alt0.get("words") or [])
        # Last resort: a single segment from the full transcript.
        if not segs and text:
            segs = [{"speaker": "0", "start": 0.0, "end": duration, "text": text}]
        return {"text": text, "duration": duration, "segments": segs}

    @staticmethod
    def _normalize_multichannel(channels: list[dict], duration: float) -> dict:
        """Online-meeting stereo: results.channels[0]=mic (owner → "Me", its diarization ignored),
        channels[1]=remotes (distinct diarized speakers preserved). Each segment is tagged with
        ``channel`` (0/1) and ``is_me``."""
        segs: list[dict] = []
        text_parts: list[str] = []
        for ch_idx, ch in enumerate(channels):
            is_me = ch_idx == 0
            alt = (ch.get("alternatives") or [{}])[0]
            text_parts.append((alt.get("transcript") or "").strip())
            # ch0 = the owner: force every word onto the single "Me" label (ignore its diarization).
            # ch1+ = remotes: keep distinct diarized speakers (one turn per speaker run).
            ch_segs = _group_words_by_speaker(alt.get("words") or [], owner_label="Me" if is_me else None)
            for s in ch_segs:
                s["channel"] = ch_idx
                s["is_me"] = is_me
            segs.extend(ch_segs)
        segs.sort(key=lambda s: (s["start"], s["channel"]))
        text = " ".join(t for t in text_parts if t).strip()
        return {"text": text, "duration": duration, "segments": segs}


# ── Sarvam (Saaras v3) ───────────────────────────────────────────────────────────────
class SarvamStt:
    """Sarvam ``/speech-to-text`` (sync). ``saaras:v3`` + ``mode=translate`` yields Hindi→English in
    one call (no separate translate step needed).

    Long audio now WORKS via the auto-chunker (≤28s windows, stitched) — so a full recording no
    longer fails. LIMITATION that remains: the sync endpoint does NOT diarize, so every window is
    one 'A' segment (no who-said-what). True diarization needs Sarvam's async Batch API (submit/
    poll/download), a larger change not wired here yet; meanwhile on-device voiceprint clustering
    separates speakers per turn downstream.
    """

    MAX_SECONDS = 28   # sync endpoint hard-caps at 30s → window everything below it
    CONCURRENCY = 2    # stay under the per-account rate limit (~60 req/min on Starter)

    def __init__(self) -> None:
        s = get_runtime_settings()
        self._base = s.sarvam_base_url.rstrip("/")
        self._key = s.sarvam_api_key
        self._model = s.sarvam_model
        self._mode = s.sarvam_mode
        self._language = s.sarvam_language
        if not self._key:
            log.warning("SARVAM_API_KEY missing — Sarvam STT calls will 403.")

    async def transcribe_diarize(self, audio, filename, content_type, prompt=None, multichannel=False) -> dict:
        if multichannel:
            return await self._transcribe_multichannel(audio, filename, content_type, prompt)
        # Sarvam sync caps at 30s, so the chunker windows EVERYTHING (even a normal ~90s Sutra
        # window becomes ~4 sub-windows) — this is what makes Sarvam usable in the live path.
        return await transcribe_chunked(self._transcribe_one, audio, filename, content_type, prompt,
                                        max_seconds=self.MAX_SECONDS, concurrency=self.CONCURRENCY,
                                        label="sarvam")

    async def _transcribe_multichannel(self, audio, filename, content_type, prompt=None) -> dict:
        # Sarvam merges channels to mono, so we never send stereo. Split client-side into 2 mono
        # passes: L=mic→"Me" (channel 0), R=system→remotes (channel 1). Splitting is in-flight only.
        left, right = await asyncio.to_thread(split_stereo_channels, audio, content_type)
        passes = [(0, True, "Me", left), (1, False, None, right)]
        outs = await asyncio.gather(*[
            transcribe_chunked(self._transcribe_one, ch_audio, f"{filename}.c{idx}.wav", "audio/wav",
                               prompt, max_seconds=self.MAX_SECONDS, concurrency=self.CONCURRENCY,
                               label=f"sarvam-c{idx}")
            for idx, _is_me, _owner, ch_audio in passes
        ])
        segs: list[dict] = []
        text_parts: list[str] = []
        for (idx, is_me, owner, _ch_audio), out in zip(passes, outs):
            text_parts.append((out.get("text") or "").strip())
            for s in out.get("segments") or []:
                s = dict(s)
                s["speaker"] = owner if owner is not None else str(s.get("speaker", "A"))
                s["channel"] = idx
                s["is_me"] = is_me
                segs.append(s)
        segs.sort(key=lambda s: (s["start"], s["channel"]))
        dur = max((s["end"] for s in segs), default=0.0)
        return {"text": " ".join(t for t in text_parts if t).strip(),
                "duration": float(dur), "segments": segs}

    async def _transcribe_one(self, audio, filename, content_type, prompt=None, multichannel=False) -> dict:
        data = {"model": self._model, "language_code": self._language}
        # `mode` is a saaras:v3-only knob (transcribe|translate|codemix|...). Older saarika models
        # reject it, so only send it for saaras.
        if self._model.startswith("saaras"):
            data["mode"] = self._mode
        files = {"file": (filename, audio, content_type or "application/octet-stream")}
        headers = {"api-subscription-key": self._key}
        log.info("sarvam transcribe: model=%s mode=%s language=%s", self._model, self._mode, self._language)
        async with httpx.AsyncClient(base_url=self._base, headers=headers, timeout=180.0) as c:
            resp = await c.post("/speech-to-text", data=data, files=files)
            resp.raise_for_status()
            body = resp.json()
        return self._normalize(body)

    @staticmethod
    def _normalize(body: dict) -> dict:
        text = (body.get("transcript") or "").strip()
        # Sarvam sync returns no diarization and no reliable duration; emit one best-effort turn.
        dur = float(body.get("audio_duration", 0.0) or 0.0)
        segs = [{"speaker": "A", "start": 0.0, "end": dur, "text": text}] if text else []
        return {"text": text, "duration": dur, "segments": segs}


# ── Sarvam Batch (async diarization + long files) ─────────────────────────────────────
class SarvamBatchStt:
    """Sarvam's async BATCH API (saaras:v3). Unlike the sync provider this DIARIZES (who-said-what)
    and handles long files (~2h), at the cost of a submit→poll→download job that takes seconds to
    minutes — so it fits the import / offline path, not live capture. mode=translate gives diarized
    clean ENGLISH from one provider. Audio is written to a temp file in-flight and the whole temp dir
    (audio + outputs) is removed after the job; only the transcript is returned.

    Needs the optional `sarvamai` SDK (lazy-imported). Live-validation pending a Sarvam credit top-up.
    """

    def __init__(self) -> None:
        s = get_runtime_settings()
        self._key = s.sarvam_api_key
        self._model = s.sarvam_model
        self._mode = s.sarvam_mode
        self._language = s.sarvam_language
        self._num_speakers = int(getattr(s, "sarvam_num_speakers", 0) or 0)
        self._timeout = int(getattr(s, "sarvam_batch_timeout", 600) or 600)
        if not self._key:
            log.warning("SARVAM_API_KEY missing — Sarvam Batch calls will 403.")

    async def transcribe_diarize(self, audio, filename, content_type, prompt=None, multichannel=False) -> dict:
        # Batch already diarizes; the multichannel flag is accepted (uniform signature) but a no-op.
        # The SDK job flow (upload/poll/download) is blocking, so run it off the event loop.
        return await asyncio.to_thread(self._run_job, audio, content_type)

    def _run_job(self, audio: bytes, content_type: str) -> dict:
        from sarvamai import SarvamAI  # optional dep, only needed for this provider

        client = SarvamAI(api_subscription_key=self._key)
        workdir = tempfile.mkdtemp(prefix="sarvam_batch_")
        in_path = os.path.join(workdir, f"audio{_ext(content_type)}")
        out_dir = os.path.join(workdir, "out")
        os.makedirs(out_dir, exist_ok=True)
        try:
            with open(in_path, "wb") as f:
                f.write(audio)
            kwargs: dict = {"model": self._model, "with_diarization": True,
                            "with_timestamps": True, "language_code": self._language}
            if self._model.startswith("saaras"):
                kwargs["mode"] = self._mode
            if self._num_speakers > 0:
                kwargs["num_speakers"] = self._num_speakers
            log.info("sarvam batch: model=%s mode=%s diarize=True lang=%s",
                     self._model, self._mode, self._language)
            job = client.speech_to_text_job.create_job(**kwargs)
            job.upload_files(file_paths=[in_path])
            job.start()
            job.wait_until_complete(poll_interval=5, timeout=self._timeout)
            job.download_outputs(output_dir=out_dir)
            outs = sorted(glob.glob(os.path.join(out_dir, "*.json")))
            if not outs:
                raise RuntimeError("sarvam batch produced no output file")
            with open(outs[0], encoding="utf-8") as f:
                body = json.load(f)
            return self._normalize(body)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)  # audio + outputs removed (in-flight only)

    @staticmethod
    def _normalize(body: dict) -> dict:
        text = (body.get("transcript") or "").strip()
        entries = ((body.get("diarized_transcript") or {}).get("entries")) or []
        segs: list[dict] = []
        for e in entries:
            t = (e.get("transcript") or "").strip()
            if not t:
                continue
            segs.append(
                {
                    "speaker": str(e.get("speaker_id", "0")),
                    "start": float(e.get("start_time_seconds", 0.0) or 0.0),
                    "end": float(e.get("end_time_seconds", 0.0) or 0.0),
                    "text": t,
                }
            )
        if not segs and text:
            segs = [{"speaker": "A", "start": 0.0, "end": 0.0, "text": text}]
        dur = max((s["end"] for s in segs), default=0.0)
        return {"text": text, "duration": float(dur), "segments": segs}


# ── Mock ─────────────────────────────────────────────────────────────────────────────
class MockStt:
    """Deterministic scripted conversation — no network, no key, no audio touched."""

    def __init__(self) -> None:
        self._p = MockProvider()

    async def transcribe_diarize(self, audio, filename, content_type, prompt=None, multichannel=False) -> dict:
        return await self._p.transcribe_diarize(audio, filename, content_type)


def get_stt_provider(byo_openai_key: str | None = None) -> SttProvider:
    """Return the configured STT provider. Constructed fresh per call (cheap) so a runtime
    ``stt_provider`` change takes effect immediately, with no process restart."""
    name = (get_runtime_settings().stt_provider or "openai").lower()
    if name == "deepgram":
        return DeepgramStt()
    if name == "sarvam":
        return SarvamStt()
    if name in ("sarvam_batch", "sarvam-batch"):
        return SarvamBatchStt()
    if name == "mock":
        return MockStt()
    return OpenAiStt(byo_openai_key)  # default: openai (honors optional per-request BYO key)
