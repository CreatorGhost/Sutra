"""Long-audio chunking for STT providers.

Splits oversized audio into windows (preferring silence boundaries), transcribes each via the
provider's single-call method, and stitches ONE timeline back with offset timestamps. This lets
any provider handle any length transparently — it mirrors Sutra's windowed-capture pipeline and,
crucially, makes a sub-30s-only engine (Sarvam sync) usable on longer windows, and lets OpenAI
(25 MB / ~23 min cap) ingest a full recording it would otherwise 400 on.

Requires ffmpeg/ffprobe (already used by services/voiceprint). All audio is handled in-flight
only and never persisted. If ffmpeg is unavailable or the clip is already short enough, this is
a no-op pass-through to a single provider call.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import subprocess
import tempfile

log = logging.getLogger("sutra.stt.chunk")

_HAVE_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None

_EXT = {
    "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/webm": ".webm", "audio/ogg": ".ogg",
    "audio/opus": ".opus", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/mpeg": ".mp3",
    "audio/aac": ".aac", "audio/flac": ".flac",
}


def _ext(content_type: str | None) -> str:
    return _EXT.get((content_type or "").split(";")[0].strip().lower(), ".bin")


def _run(args: list[str], stdin: bytes | None = None) -> tuple[int, bytes, bytes]:
    p = subprocess.run(args, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return p.returncode, p.stdout, p.stderr


def _probe_duration_file(path: str) -> float:
    rc, out, _ = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                       "-of", "default=noprint_wrappers=1:nokey=1", path])
    try:
        return float(out.decode().strip())
    except (ValueError, AttributeError):
        return 0.0


def _silence_centers(path: str) -> list[float]:
    """Timestamps (s) at the middle of detected silences — natural cut points between turns."""
    _, _, err = _run(["ffmpeg", "-hide_banner", "-nostats", "-i", path,
                      "-af", "silencedetect=noise=-30dB:d=0.4", "-f", "null", "-"])
    text = err.decode("utf-8", "ignore")
    starts = [float(x) for x in re.findall(r"silence_start: ([0-9.]+)", text)]
    ends = [float(x) for x in re.findall(r"silence_end: ([0-9.]+)", text)]
    centers = [(s + e) / 2.0 for s, e in zip(starts, ends)]
    if len(starts) > len(ends):           # trailing silence with no end → use its start
        centers.append(starts[-1])
    return sorted(centers)


def plan_windows(duration: float, centers: list[float], max_s: float, min_s: float) -> list[tuple[float, float]]:
    """Cover [0, duration] in (start, length) windows, each <= max_s, cutting at the latest
    silence center inside (start+min_s, start+max_s] when one exists, else a hard cut at max_s.
    Pure function — unit-tested."""
    if duration <= max_s + 0.1:
        return [(0.0, duration)]
    bounds = [0.0]
    cur = 0.0
    while duration - cur > max_s + 0.1:
        hi, lo = cur + max_s, cur + min_s
        cand = [c for c in centers if lo < c <= hi]
        cut = cand[-1] if cand else hi
        bounds.append(round(cut, 3))
        cur = cut
    bounds.append(duration)
    return [(bounds[i], round(bounds[i + 1] - bounds[i], 3)) for i in range(len(bounds) - 1)]


def _slice_wav(path: str, start: float, length: float) -> bytes:
    rc, out, _ = _run(["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{length:.3f}",
                       "-i", path, "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"])
    return out if rc == 0 else b""


def split_stereo_channels(audio: bytes, content_type: str | None) -> tuple[bytes, bytes]:
    """Split stereo audio into (left, right) mono 16 kHz WAV bytes — for providers that merge
    channels (Sarvam) and so need the mic (L) and system (R) channels as two separate requests.

    In-flight ONLY: the audio is written to a temp file that is removed in ``finally``; no on-disk
    audio path is introduced. If ffmpeg is unavailable the original bytes are returned for both
    channels (graceful no-op — provider still transcribes, just without the L/R separation)."""
    if not _HAVE_FFMPEG:
        return audio, audio
    tf = tempfile.NamedTemporaryFile(suffix=_ext(content_type), delete=False)
    try:
        tf.write(audio)
        tf.flush()
        tf.close()

        def _chan(map_expr: str) -> bytes:
            rc, out, _ = _run(["ffmpeg", "-v", "error", "-i", tf.name, "-af", map_expr,
                               "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"])
            return out if rc == 0 else b""

        # pan filters extract one source channel each → mono 16k. FL=left=mic, FR=right=system.
        return _chan("pan=mono|c0=FL"), _chan("pan=mono|c0=FR")
    finally:
        os.path.exists(tf.name) and os.unlink(tf.name)


def stitch(results: list[tuple[int, float, dict | None, str | None]], total_duration: float) -> dict:
    """Merge per-window results (idx, start_offset, normalized_out|None, err|None) into one
    timeline, offsetting every segment by its window start. Pure function — unit-tested.
    Speaker labels are NOT merged across windows (each window diarizes independently); Sutra's
    on-device voiceprint clustering resolves cross-window speaker identity downstream."""
    text_parts: list[str] = []
    segs: list[dict] = []
    failed = 0
    for _idx, start, out, err in sorted(results, key=lambda r: r[0]):
        if err or not out:
            failed += 1
            continue
        if out.get("text"):
            text_parts.append(out["text"].strip())
        for s in out.get("segments", []) or []:
            seg = {
                "speaker": str(s.get("speaker", "A")),
                "start": float(s.get("start", 0.0) or 0.0) + start,
                "end": float(s.get("end", 0.0) or 0.0) + start,
                "text": (s.get("text") or "").strip(),
            }
            # Carry through multichannel tags (online-meeting stereo) when the provider set them,
            # so channel/is_me survive auto-chunking. Single-channel segments stay untagged.
            if "channel" in s:
                seg["channel"] = s["channel"]
            if "is_me" in s:
                seg["is_me"] = s["is_me"]
            segs.append(seg)
    return {"text": " ".join(t for t in text_parts if t).strip(),
            "duration": float(total_duration),
            "segments": segs,
            "_windows": len(results), "_failed": failed}


async def transcribe_chunked(transcribe_one, audio: bytes, filename: str, content_type: str,
                             prompt: str | None, *, max_seconds: float, concurrency: int,
                             label: str = "stt") -> dict:
    """Run ``transcribe_one(audio, filename, content_type, prompt) -> normalized dict`` over the
    audio, auto-splitting into <= max_seconds windows when it's longer. No-op single call when
    ffmpeg is missing or the clip already fits."""
    if not _HAVE_FFMPEG:
        return await transcribe_one(audio, filename, content_type, prompt)

    def prep() -> tuple[float, list[tuple[float, bytes]]]:
        tf = tempfile.NamedTemporaryFile(suffix=_ext(content_type), delete=False)
        try:
            tf.write(audio)
            tf.flush()
            tf.close()
            dur = _probe_duration_file(tf.name)
            if dur <= max_seconds + 0.5 or dur == 0.0:
                return dur, []  # fits (or unknown) → caller does a single pass
            centers = _silence_centers(tf.name)
            wins = plan_windows(dur, centers, max_seconds, max(2.0, max_seconds * 0.35))
            return dur, [(start, _slice_wav(tf.name, start, length)) for start, length in wins]
        finally:
            os.path.exists(tf.name) and os.unlink(tf.name)

    dur, slices = await asyncio.to_thread(prep)
    if not slices:
        return await transcribe_one(audio, filename, content_type, prompt)

    log.info("%s: auto-chunking %.0fs audio into %d windows (<=%.0fs, conc=%d)",
             label, dur, len(slices), max_seconds, concurrency)
    sem = asyncio.Semaphore(max(1, concurrency))

    async def one(idx: int, start: float, wav: bytes):
        if not wav:
            return (idx, start, None, "empty slice")
        async with sem:
            try:
                return (idx, start, await transcribe_one(wav, f"{filename}.w{idx}.wav", "audio/wav", prompt), None)
            except Exception as e:  # one bad window must not sink the whole timeline
                log.warning("%s: window %d failed: %s", label, idx, repr(e)[:160])
                return (idx, start, None, repr(e)[:160])

    results = await asyncio.gather(*[one(i, s, w) for i, (s, w) in enumerate(slices)])
    merged = stitch(results, dur)
    if merged["_failed"]:
        log.warning("%s: %d/%d windows failed", label, merged["_failed"], merged["_windows"])
    return merged
