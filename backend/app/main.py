"""Sutra FastAPI app: API under /api + serves the built PWA. Audio is never persisted."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

import asyncpg
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .api import OVERRIDABLE, router
from .config import settings
from .db import apply_schema, close_pool, get_pool, init_pool
from .scheduler import start_scheduler, stop_scheduler

logging.basicConfig(level=settings.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("sutra")
STATIC = Path(__file__).parent.parent / "static"


async def _load_overrides() -> None:
    pool = await get_pool()
    row = await pool.fetchrow("SELECT data FROM settings WHERE id=1")
    data = (row["data"] if row else {}) or {}
    for k, v in data.items():
        if k in OVERRIDABLE and hasattr(settings, k):
            try:
                cur = getattr(settings, k)
                setattr(settings, k, bool(v) if isinstance(cur, bool) else type(cur)(v))
            except Exception:
                pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    last = None
    for attempt in range(20):
        try:
            await init_pool()
            await apply_schema()
            break
        except Exception as e:  # db may still be starting
            last = e
            await asyncio.sleep(1.5)
    else:
        raise RuntimeError(f"DB not reachable: {last}")
    await _load_overrides()
    start_scheduler()
    log.info("Sutra up. provider=%s speaker_id=%s consent=%s", settings.ai_provider, settings.speaker_id_mode, settings.consent_mode)
    try:
        yield
    finally:
        stop_scheduler()
        await close_pool()


app = FastAPI(title="Sutra", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_list or ["*"],
    allow_methods=["*"], allow_headers=["*"], allow_credentials=False,
)
app.include_router(router)


@app.exception_handler(asyncpg.DataError)
async def _data_error(request: Request, exc: asyncpg.DataError):
    return JSONResponse(status_code=422, content={"detail": "invalid input value"})


@app.exception_handler(OverflowError)
async def _overflow(request: Request, exc: OverflowError):
    return JSONResponse(status_code=422, content={"detail": "numeric value out of range"})


@app.exception_handler(httpx.HTTPStatusError)
async def _provider_error(request: Request, exc: httpx.HTTPStatusError):
    code = exc.response.status_code if exc.response is not None else 502
    # a 400 from the AI provider means our request/input was rejected -> client error;
    # anything else is an upstream failure.
    status = 422 if code == 400 else 502
    log.warning("AI provider error %s on %s", code, request.url.path)
    return JSONResponse(status_code=status, content={"detail": f"AI provider error ({code})"})


@app.exception_handler(httpx.RequestError)
async def _provider_unreachable(request: Request, exc: httpx.RequestError):
    log.warning("AI provider unreachable on %s: %s", request.url.path, type(exc).__name__)
    return JSONResponse(status_code=502, content={"detail": "AI provider unreachable"})


@app.get("/{full_path:path}")
async def spa(full_path: str):
    """Serve built PWA assets, with SPA fallback to index.html for client routes."""
    if full_path.startswith("api"):
        raise HTTPException(404, "not found")
    candidate = STATIC / full_path
    if full_path and candidate.is_file():
        return FileResponse(candidate)
    index = STATIC / "index.html"
    if index.is_file():
        return FileResponse(index)
    raise HTTPException(404, "frontend not built (run `npm run build` or use the full Docker image)")
