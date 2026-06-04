"""Daily-recap scheduler (APScheduler)."""
from __future__ import annotations

import logging
from zoneinfo import ZoneInfo

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from .config import settings
from .services.recap import run_daily_recap

log = logging.getLogger("sutra.scheduler")
_sched: AsyncIOScheduler | None = None


def start_scheduler() -> None:
    global _sched
    if not settings.recap_enabled:
        log.info("recap disabled; scheduler not started")
        return
    try:
        tz = ZoneInfo(settings.recap_timezone)
    except Exception:
        tz = ZoneInfo("UTC")
    try:
        hh, mm = (int(x) for x in settings.recap_time.split(":"))
    except Exception:
        hh, mm = 8, 0
    _sched = AsyncIOScheduler(timezone=tz)
    _sched.add_job(run_daily_recap, CronTrigger(hour=hh, minute=mm, timezone=tz),
                   id="daily_recap", replace_existing=True, misfire_grace_time=3600)
    _sched.start()
    log.info("scheduler started: daily recap at %02d:%02d %s", hh, mm, tz)


def stop_scheduler() -> None:
    global _sched
    if _sched is not None:
        _sched.shutdown(wait=False)
        _sched = None
