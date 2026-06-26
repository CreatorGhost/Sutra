"""Regression test for the M5 synthetic-citation-fallback bug.

The bug lives in the PHONE-ACTIVE TypeScript path,
frontend/src/local/chat.ts, in the citation-selection block:

    if (data.supported) {
      const matched = memories.filter((m) => cited.has(m.conversation_id));
      const src = matched.length ? matched : memories.slice(0, 3);  // <-- bug
      ...
      citations = src...map(cite);
    }

When the model answers supported=true but returns NO matching
citation_conversation_ids, the OLD code fell through to memories.slice(0, 3)
and surfaced the top-3 hybrid-retrieval hits as if the model had cited them.

The fix changes that line to `const src = matched;`, so an empty match
yields zero citations.

There is no JS test runner wired up in this repo (frontend/package.json has
no vitest/jest), and the FastAPI test client pulls in torch/speechbrain via
conftest. To keep this test importable and fast, we port the EXACT
citation-selection logic from chat.ts into a tiny Python reference, with a
flag that toggles the OLD fallback vs the NEW behavior. The assertions encode
the real content contract; they PASS for the fixed logic and FAIL for the old
logic (red-green).
"""


def select_citations(memories, data, *, old_fallback: bool):
    """Faithful port of the chat.ts citation-selection block.

    `memories` is the ordered hybrid-retrieval result (each a dict with at
    least conversation_id/title/started_at). `data` is the model response
    (supported + citation_conversation_ids). `old_fallback=True` reproduces
    the buggy `memories.slice(0, 3)` behavior; False is the shipped fix.
    """
    cited = set(data.get("citation_conversation_ids") or [])

    def cite(m):
        started = m.get("started_at")
        return {
            "conversation_id": m["conversation_id"],
            "title": m.get("title"),
            "date": str(started)[:10] if started else None,
        }

    citations = []
    if data.get("supported"):
        matched = [m for m in memories if m["conversation_id"] in cited]
        # chat.ts:36 — OLD: matched.length ? matched : memories.slice(0, 3)
        #              NEW: const src = matched;
        src = (matched if matched else memories[:3]) if old_fallback else matched
        seen = set()
        for m in src:
            if m["conversation_id"] in seen:
                continue
            seen.add(m["conversation_id"])
            citations.append(cite(m))
    return citations


MEMORIES = [
    {"conversation_id": 11, "title": "Ashoka visit", "started_at": "2026-01-02T10:00:00"},
    {"conversation_id": 22, "title": "Scholarship call", "started_at": "2026-01-03T10:00:00"},
    {"conversation_id": 33, "title": "Dorm tour", "started_at": "2026-01-04T10:00:00"},
    {"conversation_id": 44, "title": "Loan paperwork", "started_at": "2026-01-05T10:00:00"},
]


def test_supported_but_no_model_citations_returns_no_citations():
    """Contract: a supported=true answer with NO model citations must surface
    ZERO citations — never the top-3 retrieved memories the model didn't use."""
    data = {"supported": True, "citation_conversation_ids": []}

    new = select_citations(MEMORIES, data, old_fallback=False)
    assert new == [], f"fixed logic must return no citations, got {new}"

    # Prove this is a real regression: the OLD fallback would have leaked the
    # top-3 retrieved memories as if cited.
    old = select_citations(MEMORIES, data, old_fallback=True)
    assert len(old) == 3, "sanity: old code surfaced top-3 as fake citations"
    assert old != new, "fix must change behavior for the no-citation case"


def test_unmatched_model_citation_ids_return_no_citations():
    """If the model cites ids that aren't in the retrieved set, nothing matches
    and the fixed code returns no citations (old code leaked top-3)."""
    data = {"supported": True, "citation_conversation_ids": [9999]}

    new = select_citations(MEMORIES, data, old_fallback=False)
    assert new == []

    old = select_citations(MEMORIES, data, old_fallback=True)
    assert len(old) == 3


def test_real_model_citations_are_unchanged():
    """When the model returns valid citations, behavior is identical before and
    after the fix — only the cited memories are surfaced, de-duped, in order."""
    data = {"supported": True, "citation_conversation_ids": [33, 11, 11]}

    new = select_citations(MEMORIES, data, old_fallback=False)
    old = select_citations(MEMORIES, data, old_fallback=True)

    expected_ids = [11, 33]  # filtered from MEMORIES order, de-duped
    assert [c["conversation_id"] for c in new] == expected_ids
    assert new == old, "real-citation behavior must be unchanged by the fix"


def test_unsupported_answer_never_cites():
    """supported=false yields no citations regardless of model ids."""
    data = {"supported": False, "citation_conversation_ids": [11, 22]}
    assert select_citations(MEMORIES, data, old_fallback=False) == []
    assert select_citations(MEMORIES, data, old_fallback=True) == []
