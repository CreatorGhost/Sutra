"""Provider interface. Implementations must never persist audio."""
from __future__ import annotations

from typing import Protocol


class Provider(Protocol):
    async def transcribe_diarize(
        self, audio: bytes, filename: str, content_type: str
    ) -> dict:
        """Return {"text": str, "duration": float, "segments": [{speaker,start,end,text}]}."""
        ...

    async def extract(self, json_schema: dict, system: str, user: str) -> dict:
        """Structured-output call -> dict matching json_schema['schema']."""
        ...

    async def embed(self, texts: list[str]) -> list[list[float]]:
        ...

    async def rerank(self, query: str, docs: list[str]) -> list[float]:
        """Relevance scores in [0,1], one per doc."""
        ...
