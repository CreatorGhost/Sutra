"""Central configuration. Every value is overridable via environment / .env."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    # OpenAI
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    ai_provider: str = "openai"  # openai | mock
    model_transcribe: str = "gpt-4o-transcribe-diarize"
    # Output language: translate Hindi/Hinglish speech into clear, natural ENGLISH (like Wispr Flow)
    # so memory is easy to read & search for English-literate users. Keep names/proper nouns as spoken.
    # NOTE: transcription models translate imperfectly via prompt; if Hindi leaks through, add an
    # explicit transcribe->translate step. Set empty to disable.
    transcribe_prompt: str = (
        "This is a Hindi-English (Hinglish) conversation. Output EVERYTHING in clear, natural English — "
        "translate any Hindi or Hinglish speech into English (e.g. 'chalo kal kaam karte hain' -> "
        "'let's work tomorrow'). Do not output Devanagari or romanized Hindi; keep proper nouns and "
        "names as spoken."
    )
    model_extract: str = "gpt-5.4-mini"
    model_rerank: str = "gpt-5.4-nano"
    model_embed: str = "text-embedding-3-large"
    embed_dims: int = 1536

    # ── Speech-to-text provider (pluggable & swappable) ──────────────────────────────
    # Route /transcribe to a different STT engine WITHOUT touching the LLM channels
    # (chat/extract/embed/rerank always stay on OpenAI). Flip this one value — env
    # `STT_PROVIDER` or the runtime-settings DB row (live, no redeploy). Every provider
    # normalizes to the same {text, duration, segments:[{speaker,start,end,text}]} contract,
    # so nothing downstream (metering, voiceprints, the frontend) changes.
    stt_provider: str = "deepgram"  # openai | deepgram | sarvam | mock (env/runtime-overridable)
    # Deepgram (Nova-3). `multi` = Hindi/English code-switching. Diarization is an add-on.
    # Deepgram transcribes IN-LANGUAGE (no native translate); Hindi→English stays downstream.
    deepgram_api_key: str = ""
    deepgram_base_url: str = "https://api.deepgram.com"
    deepgram_model: str = "nova-3"
    deepgram_language: str = "multi"   # "multi" (code-switch) | "hi" | "en" | ...
    deepgram_diarize: bool = True
    # Sarvam (Saaras v3). saaras:v3 + mode=translate gives Hindi→English in one call.
    # NOTE: the SYNC endpoint caps at ~30s and does NOT diarize; full diarization + long
    # files need Sarvam's async Batch API (submit/poll/download — not wired here yet).
    sarvam_api_key: str = ""
    sarvam_base_url: str = "https://api.sarvam.ai"
    sarvam_model: str = "saaras:v3"
    sarvam_mode: str = "translate"     # transcribe | translate | codemix | verbatim | translit
    sarvam_language: str = "unknown"   # "unknown" = auto-detect; or hi-IN, en-IN, ...
    # Sarvam BATCH provider (stt_provider=sarvam_batch): async job with real diarization + long files.
    sarvam_num_speakers: int = 0       # diarization hint; 0 = auto-detect
    sarvam_batch_timeout: int = 600    # max seconds to poll a batch job for completion

    # Database
    database_url: str = "postgresql://sutra:sutra@localhost:5433/sutra"

    # Speaker identity
    speaker_id_mode: str = "voiceprint"  # voiceprint | manual | off
    voiceprint_model: str = "speechbrain/spkrec-ecapa-voxceleb"
    # Where speechbrain caches the ECAPA model. Default is the container's mounted volume; on a host run
    # set VOICEPRINT_SAVEDIR to a writable dir (the container path is read-only off-container).
    voiceprint_savedir: str = "/models/sb/ecapa"
    voiceprint_accept: float = 0.75
    voiceprint_new: float = 0.65

    # Consent
    consent_mode: str = "off"  # off | drop | redact

    # Segmentation
    segment_gap_seconds: int = 300
    segment_topic_shift: str = "on"

    # Ranking
    rank_w_rrf: float = 1.0
    rank_w_importance: float = 0.5
    rank_half_life_days: float = 30.0
    rank_rrf_k: int = 60
    rank_recency: str = "on"
    rerank: str = "off"  # off | crossencoder | llm
    rerank_model: str = "BAAI/bge-reranker-base"
    search_prefetch: int = 30
    search_topn: int = 10

    # Entity resolution
    entity_sim_threshold: float = 0.86

    # Recap email
    recap_enabled: bool = True
    recap_to: str = ""
    recap_time: str = "08:00"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = "Sutra <sutra@localhost>"
    smtp_tls: str = "starttls"  # starttls | ssl | none

    # App
    app_timezone: str = "Asia/Kolkata"
    # Includes the on-device WebView origins: http://localhost (Android, androidScheme=http) and
    # capacitor://localhost (iOS default scheme). Without these the preflighted /auth + /sync POSTs
    # are CORS-blocked on device. Packaged Electron uses a file:// (null) origin — handle that per
    # deployment (allow_origin_regex) rather than allow-listing "null" globally.
    cors_origins: str = "http://localhost:5173,http://localhost:8000,http://localhost,capacitor://localhost"
    log_level: str = "info"
    retention_days: int = 0

    # Proxy hardening (all OPTIONAL — unset => behaves exactly like USB/dev today)
    proxy_shared_secret: str = ""            # if set, every API request must send matching X-Sutra-Secret
    proxy_allowed_origins: str = ""          # comma-separated CORS allowlist; empty => permissive "*"
    max_upload_mb: int = 30                  # /transcribe audio upload cap (HTTP 413 over this)
    # Transition flag: keep accepting the legacy shared secret alongside per-user Bearer JWTs
    # (old APKs baked the secret in). Flip false after the account cutover (plan §5.1 / Phase 4).
    proxy_accept_shared_secret: bool = True

    # Tier B (hosted, authenticated, multi-tenant). All OPTIONAL — unset => Tier B endpoints reject
    # with 503 (auth disabled), and the single-tenant server variant behaves exactly as before.
    sutra_jwt_secret: str = ""               # HS256 signing secret; REQUIRED to enable /auth + /sync
    sutra_jwt_ttl_minutes: int = 10080       # access-token TTL (7d default for the test phase)

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def proxy_allowed_origins_list(self) -> list[str]:
        return [o.strip() for o in self.proxy_allowed_origins.split(",") if o.strip()]

    @property
    def max_upload_bytes(self) -> int:
        return max(0, self.max_upload_mb) * 1024 * 1024

    @property
    def use_voiceprint(self) -> bool:
        return self.speaker_id_mode.lower() == "voiceprint"


@lru_cache
def get_settings() -> "Settings":
    return Settings()


settings = get_settings()


class _RuntimeSettings:
    """Read-only view over the env-constructed ``Settings`` defaults overlaid with the
    JSONB ``settings.data`` DB row. Unknown attributes fall through to the base ``Settings``
    so callers can treat this exactly like the global ``settings`` object.

    The DB overrides are cached as a plain dict. The cache is refreshed lazily on the first
    async access and is invalidated explicitly on write (see ``set_runtime_overrides``), so a
    request-time settings change is visible across workers (each rereads the row) without any
    worker mutating the process-global ``Settings`` singleton.
    """

    __slots__ = ("_base", "_overrides")

    def __init__(self, base: "Settings", overrides: dict) -> None:
        self._base = base
        self._overrides = overrides

    def __getattr__(self, name: str):
        overrides = object.__getattribute__(self, "_overrides")
        if name in overrides:
            return overrides[name]
        return getattr(object.__getattribute__(self, "_base"), name)


# Cached DB overrides; ``None`` means "not yet loaded from the DB this process".
_runtime_overrides: dict | None = None


async def refresh_runtime_settings() -> dict:
    """(Re)load the ``settings.data`` JSONB row into the in-process cache and return it."""
    global _runtime_overrides
    from .db import get_pool  # lazy to avoid config<->db import cycle

    pool = await get_pool()
    row = await pool.fetchval("SELECT data FROM settings WHERE id=1")
    _runtime_overrides = dict(row or {})
    return _runtime_overrides


def set_runtime_overrides(overrides: dict) -> None:
    """Replace the cached DB overrides (called right after a successful write)."""
    global _runtime_overrides
    _runtime_overrides = dict(overrides)


def get_runtime_settings() -> _RuntimeSettings:
    """Synchronous accessor returning the merged (env defaults + DB overrides) settings view.

    Reads the last cached DB overrides; if the cache has never been populated this process
    it falls back to env defaults only. Callers that need freshness should call
    ``refresh_runtime_settings()`` (await) first — request handlers and startup do this.
    """
    return _RuntimeSettings(settings, _runtime_overrides if _runtime_overrides is not None else {})
