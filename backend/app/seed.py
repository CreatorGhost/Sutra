"""Demo seed: replays curated bilingual conversations through the real pipeline so search,
graph and chat are testable without recording. Run: python -m app.seed

Idempotent-ish: if a person named 'Amartya' already exists it assumes seeded and exits.
Uses whatever AI_PROVIDER is configured (mock = offline/deterministic, openai = realistic).
"""
from __future__ import annotations

import asyncio
import datetime as dt

from .db import apply_schema, close_pool, get_pool, init_pool
from .services.extraction import process_session

# (speaker_name, text) — Hindi-English code-switched, like real conversations.
CONVERSATIONS = [
    # day -2: college applications
    [
        ("Me", "Amartya, college applications ka kya scene hai? Kahan kahan apply kar raha hai?"),
        ("Amartya", "Maine teen jagah shortlist ki hain — BITS Pilani, IIT Bombay, aur Ashoka University."),
        ("Me", "Nice. Ashoka ka deadline kab tak hai?"),
        ("Amartya", "December 15. SOP draft karna hai mujhe by next week, that's the stressful part."),
        ("Me", "Don't worry, main review kar dunga. Let's meet Friday 5pm at the library."),
        ("Amartya", "Perfect. Aur Priya bhi Ashoka apply kar rahi hai, so we can prep together."),
        ("Me", "Great, I'll book the library discussion room for Friday."),
    ],
    # day -1: work standup
    [
        ("Me", "Quick standup. Priya, the payments integration kahan tak pahuncha?"),
        ("Priya", "Stripe webhook done hai, testing chal rahi hai. Refund flow is pending."),
        ("Me", "Okay. We decided to ship the checkout redesign next sprint, right?"),
        ("Priya", "Haan, decision final hai. I'll own the refund flow and finish it by Thursday."),
        ("Me", "Good. Main analytics dashboard pe kaam karunga is week."),
    ],
    # day 0: personal / planning
    [
        ("Me", "Weekend plan: Saturday ko trek jaana hai Lonavala, agar mausam thik raha."),
        ("Amartya", "Count me in! Priya ko bhi poochte hain. Kitne baje nikalenge?"),
        ("Me", "6am sharp. I'll arrange the cab. Let's keep a backup plan if it rains."),
        ("Amartya", "Theek hai. Main snacks aur water arrange kar dunga."),
    ],
]


async def main() -> None:
    await init_pool()
    await apply_schema()
    pool = await get_pool()

    if await pool.fetchval("SELECT 1 FROM people WHERE lower(canonical_name)='amartya'"):
        print("Seed already present (found 'Amartya'). Nothing to do.")
        await close_pool()
        return

    me = await pool.fetchval("INSERT INTO people(canonical_name, is_me) VALUES('Me', TRUE) RETURNING id")
    amartya = await pool.fetchval("INSERT INTO people(canonical_name) VALUES('Amartya') RETURNING id")
    priya = await pool.fetchval("INSERT INTO people(canonical_name) VALUES('Priya') RETURNING id")
    pid = {"Me": me, "Amartya": amartya, "Priya": priya}

    now = dt.datetime.now(dt.timezone.utc)
    for day_offset, convo in zip((-2, -1, 0), CONVERSATIONS):
        base = now + dt.timedelta(days=day_offset)
        sid = await pool.fetchval(
            "INSERT INTO sessions(device, status, started_at, ended_at) VALUES('seed','closed',$1,$2) RETURNING id",
            base, base + dt.timedelta(minutes=10),
        )
        labels = {}
        t = 0.0
        for name, text in convo:
            labels.setdefault(name, chr(65 + len(labels)))  # A, B, C...
            await pool.execute(
                """INSERT INTO turns(session_id, window_index, session_speaker_label, person_id, text,
                       lang, start_ts, end_ts, abs_start)
                   VALUES($1,0,$2,$3,$4,$5,$6,$7,$8)""",
                sid, labels[name], pid[name], text, "hi-en", t, t + 4.0,
                base + dt.timedelta(seconds=t),
            )
            t += 5.0
        res = await process_session(sid)
        print(f"  session {sid} (day {day_offset}): {len(res['extracted'])} conversation(s) extracted")

    counts = await pool.fetchrow(
        "SELECT (SELECT count(*) FROM conversations) c, (SELECT count(*) FROM memories) m, "
        "(SELECT count(*) FROM entities) e, (SELECT count(*) FROM edges) g, "
        "(SELECT count(*) FROM action_items) a"
    )
    print(f"Seed complete: {counts['c']} conversations, {counts['m']} memories, "
          f"{counts['e']} entities, {counts['g']} edges, {counts['a']} action items.")
    await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
