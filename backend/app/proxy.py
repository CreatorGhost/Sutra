"""Sutra intelligence proxy — STATELESS. Holds OUR OpenAI key server-side so the app works
out-of-the-box with zero key friction. No database, no user data. Audio hits ONLY /transcribe,
in-flight, and is never written to disk. The 4 text endpoints never receive audio.

Run:  uvicorn app.proxy:app --host 0.0.0.0 --port 8787
"""
from __future__ import annotations

import logging

from fastapi import Body, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .providers.openai_provider import OpenAIProvider

log = logging.getLogger("sutra.proxy")
app = FastAPI(title="Sutra Proxy", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], allow_credentials=False)

_default = OpenAIProvider()
# Minimal in-memory metering for a future buy-once / fair-use credit model (replace with a store in prod).
_usage: dict[str, dict[str, int]] = {}


def _meter(user: str | None, kind: str) -> None:
    u = _usage.setdefault(user or "anon", {})
    u[kind] = u.get(kind, 0) + 1


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
    return {"status": "ok", "service": "sutra-proxy", "models": {
        "transcribe": settings.model_transcribe, "extract": settings.model_extract, "embed": settings.model_embed}}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), prompt: str | None = Form(None),
                     voiceprints: bool = Form(False),
                     x_sutra_user: str | None = Header(None),
                     x_openai_key: str | None = Header(None)) -> dict:
    # `prompt` is the CLIENT's per-language transcription prompt (from transcript_lang → LANGS). The
    # client owns the prompt; the proxy just forwards it. None -> server fallback; "" -> no prompt.
    # `voiceprints=true` (hybrid speaker-ID): also compute a per-TURN ECAPA embedding from the SAME
    # in-flight audio and attach it to each segment. Audio stays in-flight only; only vectors returned.
    audio = await file.read()  # in-flight ONLY — never persisted
    try:
        _meter(x_sutra_user, "transcribe")
        result = await _provider(x_openai_key).transcribe_diarize(
            audio, file.filename or "audio", file.content_type or "audio/webm", prompt=prompt)
        if voiceprints:
            try:
                from .services.voiceprint import embed_segments_per_turn
                segs = result.get("segments", []) or []
                for seg, emb in zip(segs, await embed_segments_per_turn(audio, segs)):
                    seg["embedding"] = emb  # 192-d list or null (short turns)
                _meter(x_sutra_user, "voiceprint")
            except Exception as e:
                log.warning("voiceprint embedding skipped: %s", e)  # never fail transcription over this
        return result
    except Exception as e:
        raise HTTPException(502, f"transcription failed: {str(e)[:200]}")
    finally:
        del audio


@app.post("/extract")
async def extract(body: dict = Body(...), x_sutra_user: str | None = Header(None),
                  x_openai_key: str | None = Header(None)):
    _meter(x_sutra_user, "extract")
    return await _provider(x_openai_key).extract(body["json_schema"], body["system"], body["user"])


@app.post("/chat")
async def chat(body: dict = Body(...), x_sutra_user: str | None = Header(None),
               x_openai_key: str | None = Header(None)):
    _meter(x_sutra_user, "chat")
    return await _provider(x_openai_key).extract(body["json_schema"], body["system"], body["user"])


@app.post("/embed")
async def embed(body: dict = Body(...), x_sutra_user: str | None = Header(None),
                x_openai_key: str | None = Header(None)) -> dict:
    _meter(x_sutra_user, "embed")
    return {"embeddings": await _provider(x_openai_key).embed(body.get("texts", []))}


@app.post("/rerank")
async def rerank(body: dict = Body(...), x_sutra_user: str | None = Header(None),
                 x_openai_key: str | None = Header(None)) -> dict:
    _meter(x_sutra_user, "rerank")
    return {"scores": await _provider(x_openai_key).rerank(body.get("query", ""), body.get("docs", []))}


@app.get("/usage")
async def usage() -> dict:
    return _usage  # demo metering view
