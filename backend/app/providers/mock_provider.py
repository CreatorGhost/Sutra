"""Deterministic provider for tests / offline demo. No network, no key, no audio touched."""
from __future__ import annotations

import hashlib
import re

import numpy as np

from ..config import settings

# A scripted bilingual (Hindi-English code-switched) two-speaker conversation so the whole
# downstream pipeline (extraction, graph, search, chat) has realistic content to chew on.
_SCRIPT = [
    ("A", "Hey Amartya, kaisa chal raha hai college application process?"),
    ("B", "Bas chal raha hai. I shortlisted three colleges — BITS Pilani, IIT Bombay aur Ashoka."),
    ("A", "Nice. Ashoka ka deadline kab hai?"),
    ("B", "December 15. Mujhe SOP draft karna hai by next week."),
    ("A", "Okay, main help kar dunga with the review. Let's meet Friday evening."),
    ("B", "Perfect. Aur ek baat — Priya bhi apply kar rahi hai Ashoka mein."),
    ("A", "Achha! Toh hum dono mil ke prepare kar sakte hain. I'll book the library room."),
    ("B", "Done. Friday 5pm, library. Main apna SOP laata hoon."),
]


class MockProvider:
    async def transcribe_diarize(self, audio: bytes, filename: str, content_type: str) -> dict:
        # Deterministic: ignore audio content, emit the scripted conversation with timestamps.
        segs, t = [], 0.0
        for spk, text in _SCRIPT:
            dur = 1.5 + len(text) / 18.0
            segs.append({"speaker": spk, "start": round(t, 2), "end": round(t + dur, 2), "text": text})
            t += dur + 0.4
        return {"text": " ".join(s["text"] for s in segs), "duration": round(t, 2), "segments": segs}

    async def extract(self, json_schema: dict, system: str, user: str) -> dict:
        name = json_schema.get("name", "")
        if name == "rerank_scores":
            # crude lexical relevance
            docs = re.findall(r"\[\d+\]\s*(.*)", user)
            qm = set(re.findall(r"\w+", user.lower()))
            return {"scores": [min(1.0, len(set(re.findall(r"\w+", d.lower())) & qm) / 8.0) for d in docs]}
        text = user.strip()
        words = re.findall(r"\b[A-Z][a-zA-Z]+\b", text)
        names = [w for w in dict.fromkeys(words) if w not in {"The", "Let", "Okay", "Hey", "Me", "I"}][:6]
        first = text.split("\n")[0][:80] if text else "Conversation"
        return {
            "title": (first or "Conversation").strip(),
            "summary": (text[:280] + ("…" if len(text) > 280 else "")) or "No content.",
            "participants": ["Me"] + names[:2],
            "facts": [s.strip() for s in re.split(r"[.!?]\s+", text) if s.strip()][:5],
            "action_items": [{"text": "Follow up on discussed items", "owner": "Me", "due": None}],
            "decisions": [],
            "entities": [{"name": n, "type": "person", "description": None} for n in names[:3]]
            + [{"name": "Ashoka", "type": "org", "description": "university"}],
            "relations": ([{"src": names[0], "relation": "discussed_with", "dst": "Me"}] if names else []),
            "importance_score": 0.55,
            "type_tags": ["factual", "social"],
        }

    async def embed(self, texts: list[str]) -> list[list[float]]:
        out = []
        for t in texts:
            seed = int.from_bytes(hashlib.sha256(t.encode("utf-8")).digest()[:8], "big") % (2**32)
            v = np.random.RandomState(seed).randn(settings.embed_dims).astype("float32")
            v /= (np.linalg.norm(v) + 1e-9)
            out.append(v.tolist())
        return out

    async def rerank(self, query: str, docs: list[str]) -> list[float]:
        qm = set(re.findall(r"\w+", query.lower()))
        return [min(1.0, len(set(re.findall(r"\w+", d.lower())) & qm) / 8.0) for d in docs]
