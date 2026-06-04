"""Small shared helpers."""
from __future__ import annotations

import re

_DEVANAGARI = re.compile(r"[ऀ-ॿ]")
# common romanized-Hindi tokens for Hinglish detection (transcripts often come back in Latin script)
_HINGLISH = set(
    "hai kya nahi haan mera tera kar raha rahe karna chal kaise kab kyun "
    "mujhe tumhe aur bhi ka ki ke ko mein hum tum aap baat acha thik".split()
)


def detect_lang(text: str) -> str:
    if _DEVANAGARI.search(text):
        return "hi-en" if re.search(r"[a-zA-Z]", text) else "hi"
    toks = set(re.findall(r"[a-z]+", text.lower()))
    return "hi-en" if len(toks & _HINGLISH) >= 2 else "en"


def cosine(a, b) -> float:
    import numpy as np

    a = np.asarray(a, dtype="float32")
    b = np.asarray(b, dtype="float32")
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(a @ b / (na * nb))


def to_pgvector(vec) -> str:
    """asyncpg+pgvector accepts python lists once register_vector ran; but for explicit casts
    we sometimes pass a literal string."""
    return "[" + ",".join(f"{float(x):.6f}" for x in vec) + "]"
