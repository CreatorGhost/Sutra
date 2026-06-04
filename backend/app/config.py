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
    model_transcribe_fallback: str = "whisper-1"
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

    # Database
    database_url: str = "postgresql://sutra:sutra@localhost:5433/sutra"

    # Capture / windows
    window_max_seconds: int = 300
    window_min_seconds: int = 2

    # Speaker identity
    speaker_id_mode: str = "voiceprint"  # voiceprint | manual | off
    voiceprint_model: str = "speechbrain/spkrec-ecapa-voxceleb"
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
    recap_timezone: str = "Asia/Kolkata"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = "Sutra <sutra@localhost>"
    smtp_tls: str = "starttls"  # starttls | ssl | none

    # App
    app_timezone: str = "Asia/Kolkata"
    cors_origins: str = "http://localhost:5173,http://localhost:8000"
    log_level: str = "info"
    retention_days: int = 0

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def use_voiceprint(self) -> bool:
        return self.speaker_id_mode.lower() == "voiceprint"


@lru_cache
def get_settings() -> "Settings":
    return Settings()


settings = get_settings()
