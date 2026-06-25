"""Unit tests for the pluggable STT layer (providers/stt.py).

These exercise the REAL normalizer code against the documented Deepgram / Sarvam response
shapes (no network), plus the provider-selection factory. The contract every provider must
satisfy: {"text": str, "duration": float, "segments": [{speaker,start,end,text}]}.
"""
from app.config import set_runtime_overrides
from app.providers.audio_chunk import plan_windows, stitch
from app.providers.stt import (
    DeepgramStt,
    MockStt,
    OpenAiStt,
    SarvamBatchStt,
    SarvamStt,
    get_stt_provider,
)


# ── Deepgram normalizer ──────────────────────────────────────────────────────────────
DG_UTTERANCES = {
    "metadata": {"duration": 4.0, "channels": 1},
    "results": {
        "channels": [{"alternatives": [{"transcript": "Life moves pretty fast. Haan bilkul.", "words": []}]}],
        "utterances": [
            {"start": 0.0, "end": 2.1, "transcript": "Life moves pretty fast.", "speaker": 0},
            {"start": 2.3, "end": 4.0, "transcript": "Haan bilkul.", "speaker": 1},
        ],
    },
}

DG_WORDS_ONLY = {
    "metadata": {"duration": 1.6},
    "results": {
        "channels": [{"alternatives": [{
            "transcript": "Hello world Bye",
            "words": [
                {"word": "hello", "punctuated_word": "Hello", "start": 0.0, "end": 0.5, "speaker": 0},
                {"word": "world", "punctuated_word": "world", "start": 0.5, "end": 1.0, "speaker": 0},
                {"word": "bye", "punctuated_word": "Bye", "start": 1.2, "end": 1.6, "speaker": 1},
            ],
        }]}],
    },
}


def _assert_contract(out: dict) -> None:
    assert set(out) >= {"text", "duration", "segments"}
    assert isinstance(out["text"], str)
    assert isinstance(out["duration"], float)
    for s in out["segments"]:
        assert set(s) >= {"speaker", "start", "end", "text"}
        assert isinstance(s["speaker"], str)
        assert isinstance(s["start"], float) and isinstance(s["end"], float)
        assert isinstance(s["text"], str)


def test_deepgram_utterances_to_segments():
    out = DeepgramStt._normalize(DG_UTTERANCES)
    _assert_contract(out)
    assert out["duration"] == 4.0
    assert [s["speaker"] for s in out["segments"]] == ["0", "1"]
    assert out["segments"][0]["text"] == "Life moves pretty fast."
    assert out["segments"][1]["text"] == "Haan bilkul."


def test_deepgram_words_fallback_groups_by_speaker():
    out = DeepgramStt._normalize(DG_WORDS_ONLY)
    _assert_contract(out)
    # Two consecutive speaker-0 words collapse into one turn; the speaker-1 word is its own turn.
    assert [s["speaker"] for s in out["segments"]] == ["0", "1"]
    assert out["segments"][0]["text"] == "Hello world"
    assert out["segments"][1]["text"] == "Bye"
    assert out["segments"][0]["start"] == 0.0 and out["segments"][0]["end"] == 1.0


def test_deepgram_empty_is_safe():
    out = DeepgramStt._normalize({})
    _assert_contract(out)
    assert out["text"] == ""
    assert out["segments"] == []


# ── Sarvam normalizer ────────────────────────────────────────────────────────────────
def test_sarvam_single_segment():
    body = {"request_id": "x", "transcript": "let's work tomorrow",
            "language_code": "hi-IN", "language_probability": 0.98}
    out = SarvamStt._normalize(body)
    _assert_contract(out)
    assert out["text"] == "let's work tomorrow"
    assert len(out["segments"]) == 1
    assert out["segments"][0]["speaker"] == "A"
    assert out["segments"][0]["text"] == "let's work tomorrow"


def test_sarvam_empty_is_safe():
    out = SarvamStt._normalize({"transcript": ""})
    _assert_contract(out)
    assert out["segments"] == []


def test_sarvam_batch_diarized_segments():
    # Sarvam Batch output shape: diarized_transcript.entries[] with speaker_id + start/end seconds.
    body = {
        "transcript": "let's work tomorrow yes sure",
        "language_code": "hi-IN",
        "diarized_transcript": {"entries": [
            {"transcript": "let's work tomorrow", "start_time_seconds": 0.0, "end_time_seconds": 2.5, "speaker_id": "0"},
            {"transcript": "yes sure", "start_time_seconds": 2.6, "end_time_seconds": 3.8, "speaker_id": "1"},
        ]},
    }
    out = SarvamBatchStt._normalize(body)
    _assert_contract(out)
    assert [s["speaker"] for s in out["segments"]] == ["0", "1"]
    assert out["segments"][1]["text"] == "yes sure"
    assert out["duration"] == 3.8


def test_sarvam_batch_no_diarization_falls_back():
    out = SarvamBatchStt._normalize({"transcript": "just one line"})
    _assert_contract(out)
    assert len(out["segments"]) == 1 and out["segments"][0]["speaker"] == "A"


# ── Provider-selection factory ───────────────────────────────────────────────────────
def test_factory_switches_provider():
    try:
        set_runtime_overrides({"stt_provider": "deepgram"})
        assert isinstance(get_stt_provider(), DeepgramStt)
        set_runtime_overrides({"stt_provider": "sarvam"})
        assert isinstance(get_stt_provider(), SarvamStt)
        set_runtime_overrides({"stt_provider": "sarvam_batch"})
        assert isinstance(get_stt_provider(), SarvamBatchStt)
        set_runtime_overrides({"stt_provider": "mock"})
        assert isinstance(get_stt_provider(), MockStt)
        set_runtime_overrides({"stt_provider": "openai"})
        assert isinstance(get_stt_provider(), OpenAiStt)
        # Unknown / unset falls back to openai (never crashes).
        set_runtime_overrides({"stt_provider": "wat"})
        assert isinstance(get_stt_provider(), OpenAiStt)
    finally:
        set_runtime_overrides({})


# ── Auto-chunking: window planning ───────────────────────────────────────────────────
def _assert_tiles(wins, dur, max_s):
    # contiguous, in-order, each <= max_s, covering [0, dur]
    assert wins[0][0] == 0.0
    cur = 0.0
    for start, length in wins:
        assert abs(start - cur) < 1e-6
        assert 0 < length <= max_s + 0.11
        cur = start + length
    assert abs(cur - dur) < 1e-3


def test_plan_windows_short_audio_single_window():
    assert plan_windows(20.0, [], 28.0, 9.8) == [(0.0, 20.0)]


def test_plan_windows_hard_cuts_when_no_silence():
    wins = plan_windows(100.0, [], 28.0, 9.8)
    _assert_tiles(wins, 100.0, 28.0)
    assert len(wins) == 4  # 28 + 28 + 28 + 16


def test_plan_windows_prefers_silence_boundaries():
    # silences at 25s and 50s → windows should cut there, not at the hard 28/56 marks
    wins = plan_windows(60.0, [25.0, 50.0], 28.0, 9.8)
    _assert_tiles(wins, 60.0, 28.0)
    assert wins[0] == (0.0, 25.0)
    assert wins[1] == (25.0, 25.0)


# ── Auto-chunking: stitch with offset timestamps ─────────────────────────────────────
def test_stitch_offsets_and_concatenates():
    results = [  # deliberately out of order to prove sorting
        (1, 25.0, {"text": "world", "duration": 10.0,
                   "segments": [{"speaker": "1", "start": 0.0, "end": 3.0, "text": "world"}]}, None),
        (0, 0.0, {"text": "hello", "duration": 10.0,
                  "segments": [{"speaker": "0", "start": 1.0, "end": 2.0, "text": "hello"}]}, None),
        (2, 50.0, None, "boom"),  # failed window must be skipped, not crash
    ]
    out = stitch(results, 60.0)
    assert out["text"] == "hello world"
    assert out["duration"] == 60.0
    assert out["_windows"] == 3 and out["_failed"] == 1
    # second window's segment is offset by its 25s start
    assert out["segments"][0] == {"speaker": "0", "start": 1.0, "end": 2.0, "text": "hello"}
    assert out["segments"][1] == {"speaker": "1", "start": 25.0, "end": 28.0, "text": "world"}
