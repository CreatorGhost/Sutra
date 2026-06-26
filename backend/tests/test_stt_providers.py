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


def test_deepgram_single_channel_has_no_channel_or_is_me_keys():
    # Default (multichannel=False) output must NOT leak the new multichannel keys.
    for body in (DG_UTTERANCES, DG_WORDS_ONLY, {}):
        out = DeepgramStt._normalize(body)
        for s in out["segments"]:
            assert "channel" not in s and "is_me" not in s


# ── Deepgram multichannel (online-meeting stereo) ────────────────────────────────────
# results.channels[]: ch0 = Me (mic, words speaker 0), ch1 = remotes (words speakers 0 and 1).
DG_MULTICHANNEL = {
    "metadata": {"duration": 6.0, "channels": 2},
    "results": {
        "channels": [
            {"alternatives": [{
                "transcript": "Hello team",
                "words": [
                    {"word": "hello", "punctuated_word": "Hello", "start": 0.0, "end": 0.4, "speaker": 0},
                    {"word": "team", "punctuated_word": "team", "start": 0.4, "end": 0.9, "speaker": 0},
                ],
            }]},
            {"alternatives": [{
                "transcript": "Hi there sounds good",
                "words": [
                    {"word": "hi", "punctuated_word": "Hi", "start": 1.0, "end": 1.3, "speaker": 0},
                    {"word": "there", "punctuated_word": "there", "start": 1.3, "end": 1.7, "speaker": 0},
                    {"word": "sounds", "punctuated_word": "sounds", "start": 2.0, "end": 2.4, "speaker": 1},
                    {"word": "good", "punctuated_word": "good", "start": 2.4, "end": 2.8, "speaker": 1},
                ],
            }]},
        ],
    },
}


def test_deepgram_multichannel_tags_channel_and_is_me():
    out = DeepgramStt._normalize(DG_MULTICHANNEL, multichannel=True)
    _assert_contract(out)
    ch0 = [s for s in out["segments"] if s["channel"] == 0]
    ch1 = [s for s in out["segments"] if s["channel"] == 1]
    # Every channel-0 segment is the owner ("Me"), every channel-1 segment is a remote.
    assert ch0 and all(s["is_me"] is True and s["speaker"] == "Me" for s in ch0)
    assert ch1 and all(s["is_me"] is False and s["speaker"] != "Me" for s in ch1)
    # ch0's own diarization is collapsed to a single "Me" turn.
    assert len(ch0) == 1 and ch0[0]["text"] == "Hello team"
    # ch1 keeps its two distinct diarized remote speakers → two turns.
    assert len(ch1) == 2
    assert {s["speaker"] for s in ch1} == {"0", "1"}
    assert [s["text"] for s in ch1] == ["Hi there", "sounds good"]


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


# ── Deepgram request params: multichannel flag drives the params dict ─────────────────
def test_deepgram_params_single_channel_omits_multichannel():
    set_runtime_overrides({"stt_provider": "deepgram"})
    try:
        params = DeepgramStt()._build_params(multichannel=False)
        assert "multichannel" not in params and "channels" not in params
    finally:
        set_runtime_overrides({})


def test_deepgram_params_multichannel_sets_channels_two():
    set_runtime_overrides({"stt_provider": "deepgram", "deepgram_diarize": True})
    try:
        params = DeepgramStt()._build_params(multichannel=True)
        assert params["multichannel"] == "true" and params["channels"] == "2"
        assert params["diarize"] == "true"  # diarize still on when configured
    finally:
        set_runtime_overrides({})


# ── multichannel survives auto-chunking (flag forwarded per window) ───────────────────
async def test_transcribe_chunked_forwards_multichannel_flag(monkeypatch):
    # The chunker only ever passes (audio, filename, content_type, prompt) to its callable; the
    # multichannel flag must be bound (functools.partial) so it survives. Force the >1-window path
    # by making the prep step return two slices, and assert every window saw multichannel=True.
    import app.providers.audio_chunk as ac

    seen: list[bool] = []
    dg = DeepgramStt()

    async def fake_listen(self, audio, filename, content_type, prompt=None, multichannel=False):
        seen.append(multichannel)
        return {"text": "x", "duration": 1.0,
                "segments": [{"speaker": "Me", "start": 0.0, "end": 1.0, "text": "x",
                              "channel": 0, "is_me": True}]}

    # Stub the network single-call; keep the real transcribe_chunked + partial binding.
    monkeypatch.setattr(DeepgramStt, "_transcribe_one", fake_listen)
    monkeypatch.setattr(ac, "_HAVE_FFMPEG", True)
    monkeypatch.setattr(ac.asyncio, "to_thread",
                        lambda fn, *a, **k: _immediate((100.0, [(0.0, b"w0"), (50.0, b"w1")])))

    out = await dg.transcribe_diarize(b"stereo", "m.wav", "audio/wav", multichannel=True)
    assert seen == [True, True]  # both windows received the flag
    assert all(s.get("is_me") is True for s in out["segments"])

    seen.clear()
    await dg.transcribe_diarize(b"stereo", "m.wav", "audio/wav", multichannel=False)
    assert seen == [False, False]  # single-channel chunked path unchanged


async def _immediate(value):
    return value


# ── Sarvam multichannel: two passes (mic/L=Me, system/R=remotes) ──────────────────────
async def test_sarvam_multichannel_two_passes(monkeypatch):
    import app.providers.stt as stt

    monkeypatch.setattr(stt, "split_stereo_channels", lambda audio, ct: (b"LEFT", b"RIGHT"))

    calls: list[bytes] = []

    async def fake_one(self, audio, filename, content_type, prompt=None, multichannel=False):
        calls.append(audio)
        # mic pass and system pass each yield one Sarvam-style single segment.
        label = "me side" if audio == b"LEFT" else "remote side"
        return {"text": label, "duration": 2.0,
                "segments": [{"speaker": "A", "start": 0.0, "end": 2.0, "text": label}]}

    monkeypatch.setattr(SarvamStt, "_transcribe_one", fake_one)
    set_runtime_overrides({"stt_provider": "sarvam"})
    try:
        out = SarvamStt()
        res = await out.transcribe_diarize(b"stereo", "m.wav", "audio/wav", multichannel=True)
    finally:
        set_runtime_overrides({})

    assert set(calls) == {b"LEFT", b"RIGHT"}  # exactly two passes, one per channel
    ch0 = [s for s in res["segments"] if s["channel"] == 0]
    ch1 = [s for s in res["segments"] if s["channel"] == 1]
    assert ch0 and all(s["is_me"] is True and s["speaker"] == "Me" for s in ch0)
    assert ch1 and all(s["is_me"] is False for s in ch1)


async def test_sarvam_single_channel_unchanged(monkeypatch):
    # multichannel=False → one request, today's single-segment-per-window output (no channel/is_me).
    async def fake_one(self, audio, filename, content_type, prompt=None, multichannel=False):
        return {"text": "hi", "duration": 2.0,
                "segments": [{"speaker": "A", "start": 0.0, "end": 2.0, "text": "hi"}]}

    monkeypatch.setattr(SarvamStt, "_transcribe_one", fake_one)
    set_runtime_overrides({"stt_provider": "sarvam"})
    try:
        res = await SarvamStt().transcribe_diarize(b"mono", "m.wav", "audio/wav")
    finally:
        set_runtime_overrides({})
    assert len(res["segments"]) == 1
    assert "channel" not in res["segments"][0] and "is_me" not in res["segments"][0]


# ── Every provider's transcribe_diarize accepts a multichannel kwarg without TypeError ─
async def test_all_providers_accept_multichannel_kwarg(monkeypatch):
    import app.providers.stt as stt

    # Stub each provider's underlying network/SDK call so we only test the signature plumbing.
    async def dg_one(self, audio, filename, content_type, prompt=None, multichannel=False):
        return {"text": "", "duration": 0.0, "segments": []}

    async def sv_one(self, audio, filename, content_type, prompt=None, multichannel=False):
        return {"text": "", "duration": 0.0, "segments": []}

    monkeypatch.setattr(DeepgramStt, "_transcribe_one", dg_one)
    monkeypatch.setattr(SarvamStt, "_transcribe_one", sv_one)
    monkeypatch.setattr(stt, "split_stereo_channels", lambda a, ct: (b"L", b"R"))
    monkeypatch.setattr(stt.OpenAIProvider, "transcribe_diarize",
                        lambda self, *a, **k: _immediate({"text": "", "duration": 0.0, "segments": []}))
    monkeypatch.setattr(SarvamBatchStt, "_run_job",
                        lambda self, audio, content_type: {"text": "", "duration": 0.0, "segments": []})

    for name in ("openai", "deepgram", "sarvam", "sarvam_batch", "mock"):
        set_runtime_overrides({"stt_provider": name})
        try:
            prov = get_stt_provider()
            # Must not raise TypeError on the multichannel kwarg.
            await prov.transcribe_diarize(b"a", "f.wav", "audio/wav", multichannel=True)
        finally:
            set_runtime_overrides({})
