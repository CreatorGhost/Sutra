"""OpenAI provider using the REST API directly (httpx) for resilience to SDK drift.

Audio is sent in-flight to /v1/audio/transcriptions and discarded by the caller; we never
write it anywhere.
"""
from __future__ import annotations

import json
import logging

import httpx

from ..config import settings

log = logging.getLogger("sutra.openai")


class OpenAIProvider:
    def __init__(self) -> None:
        if not settings.openai_api_key or settings.openai_api_key.startswith("sk-REPLACE"):
            log.warning("OPENAI_API_KEY missing/placeholder — OpenAI calls will fail.")
        self._base = settings.openai_base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {settings.openai_api_key}"}

    def _client(self, timeout: float) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self._base, headers=self._headers, timeout=timeout)

    async def transcribe_diarize(self, audio: bytes, filename: str, content_type: str,
                                 prompt: str | None = None) -> dict:
        files = {"file": (filename, audio, content_type or "application/octet-stream")}
        data = {
            "model": settings.model_transcribe,
            "response_format": "diarized_json",
            "chunking_strategy": "auto",
        }
        # The client passes a per-LANGUAGE prompt (transcript_lang → LANGS): English translates,
        # Hinglish/Devanagari/Verbatim transcribe IN-LANGUAGE. `None` -> fall back to the server
        # default; an explicit "" (Verbatim) -> NO prompt (transcribe exactly as spoken, no normalize).
        effective_prompt = settings.transcribe_prompt if prompt is None else prompt
        if effective_prompt:
            data["prompt"] = effective_prompt
        async with self._client(600.0) as c:
            resp = await c.post("/audio/transcriptions", data=data, files=files)
            if resp.status_code == 400:
                # Some model variants reject optional params (prompt, or chunking_strategy on short
                # clips). Drop whichever the error names — or both if unclear — and retry once.
                txt = resp.text.lower()
                if "prompt" in txt:
                    data.pop("prompt", None)
                if "chunk" in txt:
                    data.pop("chunking_strategy", None)
                if "prompt" not in txt and "chunk" not in txt:
                    data.pop("prompt", None)
                    data.pop("chunking_strategy", None)
                resp = await c.post("/audio/transcriptions", data=data, files=files)
            resp.raise_for_status()
            body = resp.json()
        return self._normalize_transcription(body)

    @staticmethod
    def _normalize_transcription(body: dict) -> dict:
        segs = []
        for s in body.get("segments", []) or []:
            segs.append(
                {
                    "speaker": str(s.get("speaker", "A")),
                    "start": float(s.get("start", 0.0) or 0.0),
                    "end": float(s.get("end", 0.0) or 0.0),
                    "text": (s.get("text") or "").strip(),
                }
            )
        if not segs and body.get("text"):
            segs = [{"speaker": "A", "start": 0.0, "end": float(body.get("duration", 0.0) or 0.0), "text": body["text"].strip()}]
        return {"text": body.get("text", ""), "duration": float(body.get("duration", 0.0) or 0.0), "segments": segs}

    async def extract(self, json_schema: dict, system: str, user: str) -> dict:
        payload = {
            "model": settings.model_extract,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {"type": "json_schema", "json_schema": json_schema},
            "max_completion_tokens": 8000,
        }
        async with self._client(180.0) as c:
            resp = await c.post("/chat/completions", json=payload)
            resp.raise_for_status()
            body = resp.json()
        content = body["choices"][0]["message"]["content"]
        return json.loads(content)

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        safe = [t if (t and t.strip()) else " " for t in texts]
        payload = {"model": settings.model_embed, "input": safe, "dimensions": settings.embed_dims}
        async with self._client(120.0) as c:
            resp = await c.post("/embeddings", json=payload)
            resp.raise_for_status()
            body = resp.json()
        rows = sorted(body["data"], key=lambda d: d["index"])
        return [r["embedding"] for r in rows]

    async def rerank(self, query: str, docs: list[str]) -> list[float]:
        if not docs:
            return []
        schema = {
            "name": "rerank_scores",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "scores": {"type": "array", "items": {"type": "number"}, "description": "relevance 0..1 per doc in order"}
                },
                "required": ["scores"],
                "additionalProperties": False,
            },
        }
        joined = "\n".join(f"[{i}] {d}" for i, d in enumerate(docs))
        payload = {
            "model": settings.model_rerank,
            "messages": [
                {"role": "system", "content": "Score each document's relevance to the query from 0 to 1. Return scores in document order."},
                {"role": "user", "content": f"Query: {query}\n\nDocuments:\n{joined}"},
            ],
            "response_format": {"type": "json_schema", "json_schema": schema},
            "max_completion_tokens": 2000,
        }
        async with self._client(120.0) as c:
            resp = await c.post("/chat/completions", json=payload)
            resp.raise_for_status()
            body = resp.json()
        scores = json.loads(body["choices"][0]["message"]["content"]).get("scores", [])
        scores = (list(scores) + [0.0] * len(docs))[: len(docs)]
        return [float(x) for x in scores]
