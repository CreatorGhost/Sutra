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
    # Wipe user-data tables (NOT `users` — the seeded system user must persist; legacy single-tenant
    # inserts default their user_id to it). Tier B tables (events/minutes/priors/audit_log) included.
    await pool.execute(
        "TRUNCATE turns, conversations, memories, entities, edges, action_items, events, minutes, "
        "priors, daily_rollups, sessions, people, audit_log, usage_events RESTART IDENTITY CASCADE"
    )
    # Remove any test-created accounts (keep the seeded system user) so signup-based tests are repeatable.
    await pool.execute("DELETE FROM users WHERE id <> '00000000-0000-0000-0000-000000000001'")
    yield pool
    await close_pool()


@pytest_asyncio.fixture
async def client(_db):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        yield c
