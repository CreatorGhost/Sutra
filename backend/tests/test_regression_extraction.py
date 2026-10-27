"""Regression test for M4: process_session must report per-conversation failures.

Before the fix, process_session caught/logged each failed conversation but returned
only {session_id, conversations, extracted} — so a caller could not tell
"nothing to extract" (empty conversations) from "extraction broke" (non-empty
conversations, empty extracted). This mirrors the frontend contract
(frontend/src/local/extraction.ts) which already returns `failed` + `lastError`.

These tests drive process_session directly with its two collaborators
(segment_session, extract_conversation) monkeypatched, so they need neither a
live database nor the heavy ML deps (torch/speechbrain).
"""
from __future__ import annotations

import pytest

from app.services import extraction


async def test_failed_conversation_is_counted_and_error_surfaced(monkeypatch):
    """A conversation whose extraction raises must show up in `failed` + `last_error`."""
    async def fake_segment(_session_id: int):
        return [1, 2, 3]

    async def fake_extract(cid: int):
        if cid == 2:
            raise RuntimeError("provider boom")
        return {"conversation_id": cid, "memory_id": cid}

    monkeypatch.setattr(extraction, "segment_session", fake_segment)
    monkeypatch.setattr(extraction, "extract_conversation", fake_extract)

    out = await extraction.process_session(42)

    assert out["session_id"] == 42
    assert out["conversations"] == [1, 2, 3]
    assert len(out["extracted"]) == 2          # convs 1 and 3 succeeded
    # New contract — KeyError on the old behavior, which is the red/green pivot.
    assert out["failed"] == 1
    assert out["last_error"] == "provider boom"


async def test_total_failure_is_distinguishable_from_nothing_to_extract(monkeypatch):
    """Empty `conversations` (nothing to do) must differ from every conversation failing."""
    # Case A: nothing to extract — no conversations at all.
    async def empty_segment(_sid: int):
        return []

    async def never_called(_cid: int):  # pragma: no cover - must not run
        raise AssertionError("extract_conversation should not be called")

    monkeypatch.setattr(extraction, "segment_session", empty_segment)
    monkeypatch.setattr(extraction, "extract_conversation", never_called)
    nothing = await extraction.process_session(1)
    assert nothing["conversations"] == []
    assert nothing["extracted"] == []
    assert nothing["failed"] == 0
    assert nothing["last_error"] is None

    # Case B: extraction broke for every conversation.
    async def two_convs(_sid: int):
        return [10, 11]

    async def always_fail(_cid: int):
        raise ValueError("db unreachable")

    monkeypatch.setattr(extraction, "segment_session", two_convs)
    monkeypatch.setattr(extraction, "extract_conversation", always_fail)
    broke = await extraction.process_session(2)
    assert broke["conversations"] == [10, 11]
    assert broke["extracted"] == []
    # The pivotal distinction the finding describes: same empty `extracted`,
    # but `failed`/`last_error` separate "broke" from "nothing to do".
    assert broke["failed"] == 2
    assert broke["last_error"] == "db unreachable"
    assert broke["failed"] != nothing["failed"]


async def test_existing_response_keys_preserved(monkeypatch):
    """Additive-only: the original keys/values must be unchanged."""
    async def seg(_sid: int):
        return [7]

    async def ok(cid: int):
        return {"conversation_id": cid}

    monkeypatch.setattr(extraction, "segment_session", seg)
    monkeypatch.setattr(extraction, "extract_conversation", ok)

    out = await extraction.process_session(99)
    assert out["session_id"] == 99
    assert out["conversations"] == [7]
    assert out["extracted"] == [{"conversation_id": 7}]
    assert out["failed"] == 0
    assert out["last_error"] is None
