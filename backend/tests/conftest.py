import os
# Deterministic, offline config + ISOLATED test database (never the demo 'sutra' DB).
os.environ["AI_PROVIDER"] = "mock"
os.environ["SPEAKER_ID_MODE"] = "off"
os.environ["RECAP_ENABLED"] = "false"
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://sutra:sutra@db:5432/sutra_test"
)

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.db import apply_schema, close_pool, get_pool, init_pool
from app.main import app


@pytest_asyncio.fixture
async def _db():
    await init_pool()
    await apply_schema()
    pool = await get_pool()
    await pool.execute(
        "TRUNCATE turns, conversations, memories, entities, edges, action_items, "
        "daily_rollups, sessions, people RESTART IDENTITY CASCADE"
    )
    yield pool
    await close_pool()


@pytest_asyncio.fixture
async def client(_db):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        yield c
