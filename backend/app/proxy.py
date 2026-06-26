"""Sutra intelligence proxy — CONTENT-stateless. Holds OUR OpenAI key server-side so the app works
out-of-the-box with zero key friction. No user content is ever stored. Audio hits ONLY /transcribe,
in-flight, and is never written to disk. The 4 text endpoints never receive audio.

Auth (docs/MONETIZATION-PLAN.md §5): per-user `Authorization: Bearer <JWT>` verified locally with
the control plane's SUTRA_JWT_SECRET; the legacy X-Sutra-Secret keeps working while
PROXY_ACCEPT_SHARED_SECRET is on; with nothing configured, USB/dev behavior is unchanged.
Every valuable call is metered to usage_events (durable, batched) and gated by plan caps (402).

Run:  uvicorn app.proxy:app --host 0.0.0.0 --port 8787
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Body, Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .providers.openai_provider import OpenAIProvider
from .providers.stt import get_stt_provider
from .proxy_gate import (
    Principal,
    check_quota,
    flush_metering,
    get_snapshot,
    mem_usage_view,
    meter,
    require_user,
    start_flusher,
    stop_flusher,
)

log = logging.getLogger("sutra.proxy")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Durable metering: batch-insert usage_events every few seconds (no-ops without a DB).
    start_flusher()
    try:
        yield
    finally:
        await stop_flusher()  # final drain — a clean shutdown loses no usage rows


app = FastAPI(title="Sutra Proxy", version="1.0.0", lifespan=lifespan)
# CORS: restrict to PROXY_ALLOWED_ORIGINS if set, else stay permissive "*" (USB/dev unchanged).
# X-Sutra-Secret + Authorization must be allowed explicitly so auth survives the browser preflight.
_origins = settings.proxy_allowed_origins_list or ["*"]
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_methods=["*"],
                   allow_headers=["*", "X-Sutra-Secret", "Authorization"], allow_credentials=False)

_default = OpenAIProvider()


def _provider(byo_key: str | None) -> OpenAIProvider:
    # BYO-key is an OPTIONAL power-user/enterprise path (off by default, not in the demo flow):
    # if the client sends its own key we use it for that request only; otherwise our server key.
    if byo_key:
        p = OpenAIProvider()
        p._headers = {"Authorization": f"Bearer {byo_key}"}
        return p
    return _default


@app.get("/health")
async def health() -> dict:
    # No model names here — there is a hard product rule against exposing which AI models are used.
    return {"status": "ok", "service": "sutra-proxy"}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), prompt: str | None = Form(None),
                     voiceprints: bool = Form(False),
                     multichannel: bool = Form(False),
                     content_length: int | None = Header(None),
                     principal: Principal = Depends(require_user),
                     x_openai_key: str | None = Header(None)) -> dict:
    # `prompt` is the CLIENT's per-language transcription prompt (from transcript_lang → LANGS). The
    # client owns the prompt; the proxy just forwards it. None -> server fallback; "" -> no prompt.
    # `voiceprints=true` (hybrid speaker-ID): also compute a per-TURN ECAPA embedding from the SAME
    # in-flight audio and attach it to each segment. Audio stays in-flight only; only vectors returned.
    await check_quota(principal, "transcribe")
    cap = settings.max_upload_bytes
    # Fast path: reject by declared Content-Length before reading the body into memory.
    if cap and content_length is not None and content_length > cap:
        raise HTTPException(413, f"upload too large (max {settings.max_upload_mb} MB)")
    audio = await file.read()  # in-flight ONLY — never persisted
    # Robust path: enforce against actual bytes read (Content-Length can be absent/spoofed/chunked).
    if cap and len(audio) > cap:
        del audio
        raise HTTPException(413, f"upload too large (max {settings.max_upload_mb} MB)")
    try:
        # STT is pluggable (settings.stt_provider: openai | deepgram | sarvam | mock); the text
        # channels below stay on OpenAI. BYO key only applies to the openai STT path.
        # `multichannel=true` (online-meeting stereo): ch0=mic→"Me", ch1=remotes; segments tagged
        # channel/is_me. Default false → identical to today's single-channel behavior.
        result = await get_stt_provider(x_openai_key).transcribe_diarize(
            audio, file.filename or "audio", file.content_type or "audio/webm", prompt=prompt,
            multichannel=multichannel)
        # Meter audio SECONDS from the provider's duration (fallback: last segment end).
        secs = float(result.get("duration") or 0.0)
        if not secs:
            segs = result.get("segments") or []
            secs = max((float(s.get("end") or 0.0) for s in segs), default=0.0)
        meter(principal, "transcribe", amount=secs)
        if voiceprints:
            try:
                from .services.voiceprint import embed_segments_per_turn
                segs = result.get("segments", []) or []
                for seg, emb in zip(segs, await embed_segments_per_turn(audio, segs)):
                    seg["embedding"] = emb  # 192-d list or null (short turns)
                meter(principal, "voiceprint")
            except Exception as e:
                log.warning("voiceprint embedding skipped: %s", e)  # never fail transcription over this
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"transcription failed: {str(e)[:200]}")
    finally:
        del audio


def _require_fields(body: dict, *keys: str) -> None:
    for k in keys:
        if body.get(k) is None:
            raise HTTPException(422, f"missing field: {k}")


@app.post("/extract")
async def extract(body: dict = Body(...), principal: Principal = Depends(require_user),
                  x_openai_key: str | None = Header(None)):
    _require_fields(body, "json_schema", "system", "user")
    await check_quota(principal, "extract")
    meter(principal, "extract")
    try:
        return await _provider(x_openai_key).extract(body["json_schema"], body["system"], body["user"])
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"text channel failed: {str(e)[:200]}")


@app.post("/chat")
async def chat(body: dict = Body(...), principal: Principal = Depends(require_user),
               x_openai_key: str | None = Header(None)):
    _require_fields(body, "json_schema", "system", "user")
    await check_quota(principal, "chat")
    meter(principal, "chat")
    try:
        return await _provider(x_openai_key).extract(body["json_schema"], body["system"], body["user"])
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"text channel failed: {str(e)[:200]}")


@app.post("/embed")
async def embed(body: dict = Body(...), principal: Principal = Depends(require_user),
                x_openai_key: str | None = Header(None)) -> dict:
    await check_quota(principal, "embed")
    meter(principal, "embed")
    return {"embeddings": await _provider(x_openai_key).embed(body.get("texts", []))}


@app.post("/rerank")
async def rerank(body: dict = Body(...), principal: Principal = Depends(require_user),
                 x_openai_key: str | None = Header(None)) -> dict:
    await check_quota(principal, "rerank")
    meter(principal, "rerank")
    return {"scores": await _provider(x_openai_key).rerank(body.get("query", ""), body.get("docs", []))}


@app.get("/usage")
async def usage(principal: Principal = Depends(require_user)) -> dict:
    """Per-user month-to-date usage + plan caps (Settings → Account reads this). Falls back to the
    in-memory demo counters for legacy shared-secret / USB-dev callers."""
    if principal.gated and principal.user_id:
        await flush_metering()  # show the freshest numbers, not up to 5s stale
        snap = await get_snapshot(principal.user_id, fresh=True)
        if snap is None:
            return {"available": False}  # control-plane DB not reachable from this proxy
        return {"available": True, **snap}
    return mem_usage_view()
