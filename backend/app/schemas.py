"""Pydantic request models + the strict JSON schema used for LLM extraction."""
from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

ENTITY_TYPES = ["person", "project", "topic", "org", "place", "event", "commitment"]


# ----- Tier B auth request bodies -----
# A pragmatic email check (no `email-validator` dep added): one @, non-empty local + dotted domain.
# We normalize to a trimmed, lowercased string; CITEXT in the DB makes the uniqueness case-insensitive.
import re as _re

_EMAIL_RE = _re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class SignupRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=200)

    @field_validator("email")
    @classmethod
    def _valid_email(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("invalid email address")
        return v


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=200)

    @field_validator("email")
    @classmethod
    def _norm_email(cls, v: str) -> str:
        return v.strip().lower()


class RequestResetBody(BaseModel):
    email: str = Field(min_length=3, max_length=254)

    @field_validator("email")
    @classmethod
    def _norm_email(cls, v: str) -> str:
        return v.strip().lower()


class ResetBody(BaseModel):
    token: str = Field(min_length=1, max_length=512)
    new_password: str = Field(min_length=8, max_length=200)


class DeleteAccountRequest(BaseModel):
    """Fresh confirmation for DELETE /auth/account: password accounts confirm with their password;
    social accounts (no password hash) confirm by typing their email."""
    password: str | None = Field(default=None, max_length=200)
    confirm_email: str | None = Field(default=None, max_length=254)


# ----- API request bodies -----
class SessionCreate(BaseModel):
    device: str | None = None


class PersonCreate(BaseModel):
    canonical_name: str = Field(min_length=1, max_length=120)
    is_me: bool = False
    notes: str | None = Field(default=None, max_length=2000)


class TurnSpeakerUpdate(BaseModel):
    person_id: int | None = None
    canonical_name: str | None = None  # create-or-reuse a person by name
    apply_to_label: bool = True        # relabel every turn with the same session_speaker_label
    enroll_voiceprint: bool = False    # also attach this session-label's voiceprint to the person


class SearchRequest(BaseModel):
    q: str = Field(min_length=1, max_length=2000)
    top_n: int | None = Field(default=None, ge=1, le=200)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: list[dict] = Field(default_factory=list)


class RelabelRequest(BaseModel):
    person_id: int | None = None
    name: str | None = Field(default=None, max_length=120)
    is_me: bool = False


class SettingsUpdate(BaseModel):
    data: dict


# ----- Strict JSON schema for extraction (OpenAI Structured Outputs) -----
def _obj(props: dict, required: list[str]) -> dict:
    return {
        "type": "object",
        "properties": props,
        "required": required,
        "additionalProperties": False,
    }


EXTRACTION_JSON_SCHEMA: dict = {
    "name": "conversation_intelligence",
    "strict": True,
    "schema": _obj(
        {
            "title": {"type": "string", "description": "short, specific conversation title"},
            "summary": {"type": "string", "description": "concise neutral summary (3-6 sentences)"},
            "participants": {
                "type": "array",
                "items": {"type": "string"},
                "description": "display names of speakers present (use 'Me' for the device owner)",
            },
            "facts": {"type": "array", "items": {"type": "string"}},
            "action_items": {
                "type": "array",
                "items": _obj(
                    {
                        "text": {"type": "string"},
                        "owner": {"type": ["string", "null"]},
                        "due": {"type": ["string", "null"], "description": "ISO date YYYY-MM-DD or null"},
                        "steps": {"type": "array", "items": {"type": "string"},
                                  "description": "ordered sub-steps/details discussed for this action, grounded in the transcript; [] if none"},
                    },
                    ["text", "owner", "due", "steps"],
                ),
            },
            "decisions": {"type": "array", "items": {"type": "string"}},
            "entities": {
                "type": "array",
                "items": _obj(
                    {
                        "name": {"type": "string"},
                        "type": {"type": "string", "enum": ENTITY_TYPES},
                        "description": {"type": ["string", "null"]},
                    },
                    ["name", "type", "description"],
                ),
            },
            "relations": {
                "type": "array",
                "items": _obj(
                    {
                        "src": {"type": "string", "description": "source entity name"},
                        "relation": {"type": "string", "description": "short verb phrase, e.g. 'works_on'"},
                        "dst": {"type": "string", "description": "destination entity name"},
                    },
                    ["src", "relation", "dst"],
                ),
            },
            "importance_score": {
                "type": "number",
                "description": "0..1 — how important/durable this conversation is to remember",
            },
            "type_tags": {
                "type": "array",
                "items": {"type": "string", "enum": ["decision", "commitment", "factual", "social", "task", "idea"]},
            },
            # Kept in sync with frontend/src/local/aiPrompts.ts EXTRACTION_JSON_SCHEMA (extract-v2).
            "speaker_names": {
                "type": "array",
                "items": _obj(
                    {
                        "speaker": {"type": "string"},
                        "name": {"type": ["string", "null"]},
                        "basis": {"type": "string", "enum": ["self_introduction", "addressed_by_other", "named_by_other", "unknown"]},
                        "confidence": {"type": "string", "enum": ["high", "low"]},
                    },
                    ["speaker", "name", "basis", "confidence"],
                ),
            },
            # Scheduled / time-bound events discussed (meetings, deadlines). datetime resolved vs the
            # "Today's date" line prepended to the transcript. Kept in sync with frontend aiPrompts.ts.
            "events": {
                "type": "array",
                "items": _obj(
                    {
                        "title": {"type": "string"},
                        "when": {"type": "string", "description": "time/date exactly as spoken"},
                        "datetime": {"type": ["string", "null"], "description": "ISO 8601 YYYY-MM-DDTHH:MM or null"},
                        "kind": {"type": "string", "enum": ["meeting", "call", "deadline", "reminder", "other"]},
                    },
                    ["title", "when", "datetime", "kind"],
                ),
            },
        },
        [
            "title", "summary", "participants", "facts", "action_items",
            "decisions", "entities", "relations", "importance_score", "type_tags", "speaker_names", "events",
        ],
    ),
}
