"""Async Postgres pool with pgvector codec registration and idempotent schema apply."""
from __future__ import annotations

import json
import logging
from pathlib import Path

import asyncpg
from pgvector.asyncpg import register_vector

from .config import settings

log = logging.getLogger("sutra.db")
_pool: asyncpg.Pool | None = None
_SCHEMA_PATH = Path(__file__).parent / "db" / "schema.sql"


async def _init_conn(conn: asyncpg.Connection) -> None:
    # Ensure the vector type exists *before* registering its codec (fresh-DB ordering).
    await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
    await register_vector(conn)
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
    await conn.set_type_codec("json", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def init_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            dsn=settings.database_url, min_size=1, max_size=10, init=_init_conn
        )
        log.info("db pool created")
    return _pool


async def get_pool() -> asyncpg.Pool:
    if _pool is None:
        await init_pool()
    assert _pool is not None
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def apply_schema() -> None:
    pool = await get_pool()
    sql = _SCHEMA_PATH.read_text(encoding="utf-8")
    async with pool.acquire() as conn:
        await conn.execute(sql)
    log.info("schema applied")
