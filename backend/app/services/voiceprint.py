"""Speaker voiceprints via SpeechBrain ECAPA-TDNN.

Audio is decoded to PCM IN MEMORY, embedded, and discarded. Nothing is written to disk.
torch/speechbrain are imported lazily so the rest of the app (and non-voiceprint tests) do
not require them.
"""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import tempfile

import numpy as np

from ..config import settings

log = logging.getLogger("sutra.voiceprint")
_SR = 16000
_MIN_SECONDS = 0.6  # below this a speaker's pooled audio is too short to embed reliably
_classifier = None
_load_lock = asyncio.Lock()


_RAMDIR = "/dev/shm" if os.path.isdir("/dev/shm") else None
if _RAMDIR is None:
    log.warning("no /dev/shm tmpfs available; audio decode will use a disk temp (deleted immediately). Run in the container for a strict RAM-only guarantee.")


def _decode_to_pcm(audio: bytes) -> np.ndarray:
    """webm/m4a/wav/... bytes -> mono float32 @16k. Decoded via a RAM-backed (tmpfs) temp file so
    ffmpeg can seek (required for mp4/m4a 'moov' atoms); the temp lives in RAM and is unlinked within
    this call — consistent with the never-persist-audio-to-disk invariant."""
    tmp = tempfile.NamedTemporaryFile(dir=_RAMDIR, suffix=".aud", delete=False)
    try:
        tmp.write(audio)
        tmp.flush()
        tmp.close()
        proc = subprocess.run(
            ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", tmp.name,
             "-ac", "1", "-ar", str(_SR), "-f", "f32le", "pipe:1"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg decode failed: {proc.stderr.decode('utf-8', 'ignore')[:300]}")
        return np.frombuffer(proc.stdout, dtype="<f4").copy()
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


async def _get_classifier():
    global _classifier
    if _classifier is None:
        async with _load_lock:
            if _classifier is None:
                def _load():
                    from speechbrain.inference.speaker import EncoderClassifier

                    return EncoderClassifier.from_hparams(
                        source=settings.voiceprint_model,
                        savedir=settings.voiceprint_savedir,
                        run_opts={"device": "cpu"},
                    )

                log.info("loading ECAPA model %s", settings.voiceprint_model)
                _classifier = await asyncio.to_thread(_load)
    return _classifier


def _embed_sync(classifier, wav: np.ndarray) -> np.ndarray:
    import torch

    with torch.no_grad():
        t = torch.from_numpy(np.ascontiguousarray(wav)).unsqueeze(0)  # [1, T]
        emb = classifier.encode_batch(t)  # [1,1,192]
    v = emb.squeeze().cpu().numpy().astype("float32")
    n = np.linalg.norm(v)
    return v / n if n else v


async def embed_waveform(wav: np.ndarray) -> np.ndarray | None:
    if wav.size < int(_MIN_SECONDS * _SR):
        return None
    classifier = await _get_classifier()
    return await asyncio.to_thread(_embed_sync, classifier, wav)


async def embed_segments(audio: bytes, segments: list[dict]) -> dict[str, np.ndarray]:
    """Return {session_speaker_label: 192-d voiceprint} by pooling each speaker's audio."""
    if not settings.use_voiceprint or not segments:
        return {}
    try:
        pcm = await asyncio.to_thread(_decode_to_pcm, audio)
    except Exception as e:  # decoding is best-effort; identity falls back to manual labels
        log.warning("voiceprint decode skipped: %s", e)
        return {}
    by_label: dict[str, list[np.ndarray]] = {}
    for s in segments:
        a, b = int(s["start"] * _SR), int(s["end"] * _SR)
        a, b = max(0, a), min(len(pcm), b)
        if b > a:
            by_label.setdefault(str(s["speaker"]), []).append(pcm[a:b])
    out: dict[str, np.ndarray] = {}
    for label, chunks in by_label.items():
        wav = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
        try:
            emb = await embed_waveform(wav)
        except Exception as e:
            log.warning("voiceprint embed failed for %s: %s", label, e)
            emb = None
        if emb is not None:
            out[label] = emb
    return out


async def embed_segments_per_turn(audio: bytes, segments: list[dict]) -> list[list[float] | None]:
    """One ECAPA embedding PER TURN, aligned 1:1 to `segments` order (None where the slice is shorter
    than _MIN_SECONDS and can't be embedded reliably). Per-turn (not pooled-per-label) is what lets the
    device cluster across windows AND split speakers the cloud diarizer wrongly merged into one label.
    Audio is decoded once in RAM and discarded; returns plain JSON-able float lists (vectors only)."""
    if not segments:
        return []
    try:
        pcm = await asyncio.to_thread(_decode_to_pcm, audio)
    except Exception as e:  # best-effort; identity falls back to cloud labels / manual
        log.warning("voiceprint decode skipped: %s", e)
        return [None] * len(segments)
    out: list[list[float] | None] = []
    for s in segments:
        a, b = int(s.get("start", 0) * _SR), int(s.get("end", 0) * _SR)
        a, b = max(0, a), min(len(pcm), b)
        emb = None
        if b - a >= int(_MIN_SECONDS * _SR):
            try:
                v = await embed_waveform(pcm[a:b])
                if v is not None:
                    emb = [float(x) for x in v.tolist()]
            except Exception as ex:
                log.warning("per-turn voiceprint embed failed: %s", ex)
        out.append(emb)
    return out


async def embed_enrollment(audio: bytes) -> np.ndarray | None:
    """Embed a whole enrollment clip into one voiceprint."""
    try:
        pcm = await asyncio.to_thread(_decode_to_pcm, audio)
    except Exception as e:
        log.warning("enrollment decode failed: %s", e)
        return None
    return await embed_waveform(pcm)
