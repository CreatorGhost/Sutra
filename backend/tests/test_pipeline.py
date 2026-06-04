import pytest


async def test_health(client):
    r = await client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


async def test_full_pipeline_and_retrieval(client):
    sid = (await client.post("/api/sessions", json={"device": "test"})).json()["id"]
    ing = await client.post(
        f"/api/sessions/{sid}/windows",
        files={"file": ("w.webm", b"not-real-audio-mock-ignores-it", "audio/webm")},
        data={"window_index": "0"},
    )
    assert ing.status_code == 200
    assert len(ing.json()["turns"]) >= 6

    await client.post(f"/api/sessions/{sid}/close")
    proc = (await client.post(f"/api/sessions/{sid}/process")).json()
    assert len(proc["extracted"]) >= 1

    convs = (await client.get("/api/conversations")).json()
    assert len(convs) >= 1 and convs[0]["summary"]

    # conversation detail must not 500 (regression: SELECT * leaked a vector column)
    cid = convs[0]["id"]
    det = await client.get(f"/api/conversations/{cid}")
    assert det.status_code == 200, det.text
    body = det.json()
    assert body["memory"] is not None and "embedding" not in body["memory"]
    assert isinstance(body["turns"], list)

    res = (await client.post("/api/search", json={"q": "Ashoka college application"})).json()
    assert len(res["results"]) >= 1

    chat = (await client.post("/api/chat", json={"message": "What colleges came up?"})).json()
    assert "answer" in chat and isinstance(chat["citations"], list)

    g = (await client.get("/api/graph")).json()
    assert len(g["nodes"]) >= 1

    rec = (await client.post("/api/recap/run", json={})).json()
    assert rec["rollup"] is not None


async def test_no_audio_columns_anywhere(client):
    from app.db import get_pool
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'"
    )
    audio_words = ("audio", "wav", "webm", "blob", "pcm", "mp3", "waveform", "recording")
    offenders = [(r["table_name"], r["column_name"]) for r in rows
                 if any(w in r["column_name"].lower() for w in audio_words)]
    assert offenders == [], f"audio-like columns found: {offenders}"


async def test_bad_inputs_return_4xx_not_500(client):
    assert (await client.get("/api/conversations/999999")).status_code == 404
    assert (await client.post("/api/sessions/999999/windows",
            files={"file": ("w.webm", b"x", "audio/webm")}, data={"window_index": "0"})).status_code == 404
    assert (await client.patch("/api/action_items/1", json={"status": "bogus"})).status_code == 400
    # wrong-typed bodies must be 422 (regression: untyped body -> asyncpg DataError -> 500)
    assert (await client.post("/api/sessions", json={"device": 123})).status_code == 422
    assert (await client.post("/api/sessions/1/speakers/A", json={"person_id": "abc"})).status_code == 422
    assert (await client.post("/api/sessions/1/speakers/A", json={"person_id": [1]})).status_code == 422
    assert (await client.post("/api/sessions/1/speakers/A", json={"person_id": 3.5})).status_code == 422
    # 404 on missing session for close/process
    assert (await client.post("/api/sessions/999999/close")).status_code == 404
    assert (await client.post("/api/sessions/999999/process")).status_code == 404
