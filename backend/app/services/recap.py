"""Daily recap: build a per-day rollup and email it (SMTP). Transcripts only; no audio."""
from __future__ import annotations

import datetime as dt
import json
import logging
from email.message import EmailMessage

import aiosmtplib
from jinja2 import Template
from zoneinfo import ZoneInfo

from ..config import settings
from ..db import get_pool
from ..providers import get_provider

log = logging.getLogger("sutra.recap")

_HTML = Template(
    """<div style="font-family:Inter,system-ui,sans-serif;max-width:640px;margin:auto;color:#1a1a1a">
  <h2 style="margin-bottom:4px">Sutra — daily recap</h2>
  <div style="color:#888;font-size:13px;margin-bottom:16px">{{ day }}</div>
  <p style="font-size:15px;line-height:1.6">{{ summary }}</p>
  {% if highlights %}<h3>Highlights</h3><ul>{% for h in highlights %}<li style="margin:6px 0">{{ h }}</li>{% endfor %}</ul>{% endif %}
  {% if open_actions %}<h3>Open action items</h3><ul>{% for a in open_actions %}<li style="margin:6px 0">{{ a.text }}{% if a.owner %} <em style="color:#888">— {{ a.owner }}</em>{% endif %}{% if a.due %} <strong>(due {{ a.due }})</strong>{% endif %}</li>{% endfor %}</ul>{% endif %}
  <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
  <div style="color:#aaa;font-size:12px">Sutra stores transcripts and derived memory only — never audio.</div>
</div>"""
)


async def build_rollup(day: dt.date) -> dict:
    pool = await get_pool()
    mems = await pool.fetch(
        """SELECT m.summary, m.importance_score, c.title
           FROM memories m JOIN conversations c ON c.id=m.conversation_id
           WHERE (c.started_at AT TIME ZONE $2)::date = $1
           ORDER BY m.importance_score DESC""",
        day, settings.app_timezone,
    )
    actions = await pool.fetch(
        """SELECT ai.text, ai.owner, ai.due FROM action_items ai
           JOIN conversations c ON c.id=ai.source_conversation
           WHERE ai.status='open' AND (c.started_at AT TIME ZONE $2)::date = $1""",
        day, settings.app_timezone,
    )
    highlights = [f"{m['title']}: {m['summary']}" for m in mems[:5]]
    open_actions = [{"text": a["text"], "owner": a["owner"], "due": a["due"].isoformat() if a["due"] else None} for a in actions]

    if mems:
        provider = get_provider()
        joined = "\n".join(f"- {m['title']}: {m['summary']}" for m in mems)
        schema = {
            "name": "day_summary", "strict": True,
            "schema": {"type": "object", "properties": {"summary": {"type": "string"}},
                       "required": ["summary"], "additionalProperties": False},
        }
        try:
            summary = (await provider.extract(schema, "Summarize the day's conversations in 3-4 sentences for a personal recap email.", joined))["summary"]
        except Exception as e:
            log.warning("recap summary LLM failed: %s", e)
            summary = f"{len(mems)} conversation(s) today."
    else:
        summary = "No conversations recorded today."

    await pool.execute(
        """INSERT INTO daily_rollups(day, summary, highlights, open_actions)
           VALUES($1,$2,$3,$4)
           ON CONFLICT (user_id, day) DO UPDATE SET summary=EXCLUDED.summary,
               highlights=EXCLUDED.highlights, open_actions=EXCLUDED.open_actions""",
        day, summary, highlights, open_actions,
    )
    return {"day": day.isoformat(), "summary": summary, "highlights": highlights, "open_actions": open_actions}


async def send_recap_email(day: dt.date) -> bool:
    rollup = await build_rollup(day)
    if not settings.smtp_host or not settings.recap_to:
        log.info("recap built for %s but SMTP/recipient not configured; email skipped", day)
        return False
    msg = EmailMessage()
    msg["From"] = settings.smtp_from
    msg["To"] = settings.recap_to
    msg["Subject"] = f"Sutra recap — {day.isoformat()}"
    msg.set_content(rollup["summary"])
    msg.add_alternative(_HTML.render(day=day.isoformat(), **rollup), subtype="html")
    use_tls = settings.smtp_tls.lower() == "ssl"
    start_tls = settings.smtp_tls.lower() == "starttls"
    await aiosmtplib.send(
        msg, hostname=settings.smtp_host, port=settings.smtp_port,
        username=settings.smtp_user or None, password=settings.smtp_password or None,
        use_tls=use_tls, start_tls=start_tls,
    )
    pool = await get_pool()
    await pool.execute("UPDATE daily_rollups SET emailed_at=now() WHERE day=$1", day)
    log.info("recap emailed for %s to %s", day, settings.recap_to)
    return True


async def run_daily_recap() -> None:
    try:
        tz = ZoneInfo(settings.app_timezone)
    except Exception:
        tz = dt.timezone.utc
    today = dt.datetime.now(tz).date()
    try:
        await send_recap_email(today)
    except Exception as e:
        log.exception("daily recap failed: %s", e)
