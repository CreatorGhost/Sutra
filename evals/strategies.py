"""Extraction strategies for the harness. 'combined' = the current single-call extraction.
'entity_pass' = a dedicated entity+relation call (salient real-world entities only, Hinglish few-shot,
canonical names + correct types) while keeping the combined call for action items (which are already strong)."""
from app.schemas import EXTRACTION_JSON_SCHEMA
from app.services.extraction import SYSTEM as COMBINED_SYSTEM

ENTITY_SYSTEM = (
    "Extract ONLY the salient, durable, real-world ENTITIES (and their relationships) from this "
    "Hindi-English (Hinglish) conversation. Read both languages; keep proper nouns as spoken.\n"
    "INCLUDE: named people (use 'Me' for the device owner; include people referred to by role like "
    "'Landlord'/'Doctor'/'Mummy'), organizations, named projects/products/tools, places, named events "
    "(e.g. 'Saturday trek'), and explicit commitments.\n"
    "EXCLUDE: generic objects (cab, snacks, water, flat, room), dates/times/days, quantities, and "
    "non-named transient nouns (e.g. 'new flow'). Use the CANONICAL full name (e.g. 'Ashoka University' "
    "not 'Ashoka'; 'Stripe' the org, not 'Stripe webhook') and the most accurate type. Deduplicate.\n\n"
    "Examples:\n"
    "T: 'Amartya ne Ashoka University aur BITS Pilani shortlist kiya, SOP review karna hai.'\n"
    "Entities: Me(person), Amartya(person), Ashoka University(org), BITS Pilani(org), SOP(topic).\n"
    "T: 'Priya refund flow Thursday tak finish karegi, phir checkout redesign ship karenge.'\n"
    "Entities: Me(person), Priya(person), refund flow(project), checkout redesign(project).  [NOT 'Thursday']\n"
    "T: 'Saturday ko Lonavala trek, main cab arrange karunga, Amartya snacks layega.'\n"
    "Entities: Me(person), Amartya(person), Lonavala(place), Saturday trek(event).  [NOT 'cab'/'snacks'/'Saturday']"
)

ENTITY_TYPES = ["person", "project", "topic", "org", "place", "event", "commitment"]
ENTITY_SCHEMA = {
    "name": "entities_only", "strict": True,
    "schema": {"type": "object", "additionalProperties": False, "required": ["entities", "relations"],
        "properties": {
            "entities": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                "required": ["name", "type", "description"],
                "properties": {"name": {"type": "string"}, "type": {"type": "string", "enum": ENTITY_TYPES},
                               "description": {"type": ["string", "null"]}}}},
            "relations": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                "required": ["src", "relation", "dst"],
                "properties": {"src": {"type": "string"}, "relation": {"type": "string"}, "dst": {"type": "string"}}}}}},
}


async def combined(provider, transcript, sample=None):
    d = await provider.extract(EXTRACTION_JSON_SCHEMA, COMBINED_SYSTEM, transcript)
    return {"entities": d.get("entities", []) or [], "action_items": d.get("action_items", []) or []}


async def entity_pass(provider, transcript, sample=None):
    d = await provider.extract(EXTRACTION_JSON_SCHEMA, COMBINED_SYSTEM, transcript)   # actions unchanged
    e = await provider.extract(ENTITY_SCHEMA, ENTITY_SYSTEM, transcript)              # dedicated entities
    return {"entities": e.get("entities", []) or [], "action_items": d.get("action_items", []) or []}


STRATEGIES = {"combined": combined, "entity_pass": entity_pass}

ENTITY_GUIDANCE = (
    "\n\nENTITY RULES: include named people (use 'Me' for the device owner; include people referred to by "
    "role like Landlord/Doctor/Mummy), organizations, named projects/products/tools, places, and named events "
    "(e.g. 'Saturday trek'). EXCLUDE generic objects (cab, snacks, water, flat, room), dates/times/days, "
    "quantities, and transient non-named nouns (e.g. 'new flow'). Use the CANONICAL full name (e.g. "
    "'Ashoka University', 'Stripe' the org not 'Stripe webhook') and the most accurate type; deduplicate."
)


async def combined_v2(provider, transcript, sample=None):
    d = await provider.extract(EXTRACTION_JSON_SCHEMA, COMBINED_SYSTEM + ENTITY_GUIDANCE, transcript)
    return {"entities": d.get("entities", []) or [], "action_items": d.get("action_items", []) or []}


STRATEGIES["combined_v2"] = combined_v2


# ---------------------------------------------------------------------------
# "Your Context" A/B arms — inject the sample's profile as PRIORS-NOT-TRUTH.
# These read sample["profile"] and render a compact <known_entities> block. The
# baseline arms above ignore `sample`, so any delta is attributable to the profile.
# ---------------------------------------------------------------------------
import copy as _copy

PRIORS_PREAMBLE = (
    "\n\nKNOWN CONTEXT (priors — the user's known people/projects/orgs; these MAY be outdated). "
    "Use these CANONICAL names/types to disambiguate and canonicalize entities you find (e.g. resolve "
    "'Raju'/'राज' to 'Raj' if Raj is listed). Prefer linking a mention to a listed entity over inventing "
    "a new node, BUT: (1) only output an entity if THIS conversation actually mentions it — do NOT add a "
    "prior that was not discussed; (2) if the conversation contradicts a prior (role/company/relationship "
    "changed), TRUST the conversation and keep the spoken form; (3) if a mention does NOT match any listed "
    "entity, treat it as NEW — never force it onto a listed entity."
)

LINKING_INSTRUCTION = (
    " For each entity also set links_to_profile = 'known' (matches a listed prior), 'new' (not a prior), "
    "or 'unsure', and candidate_id = the listed CANONICAL name it links to (else null)."
)


def render_known_entities(profile: dict | None) -> str:
    if not profile:
        return ""
    parts: list[str] = []
    for bucket, kind in (("people", "person"), ("projects", "project"), ("orgs", "org"), ("places", "place")):
        for it in (profile.get(bucket) or []):
            nm = it.get("name")
            if not nm:
                continue
            al = it.get("aliases") or []
            alias = f" [aka {', '.join(al)}]" if al else ""
            rel = f" ({it['rel']})" if it.get("rel") else ""
            parts.append(f"{nm}{alias}{rel} — {kind}")
    head = []
    if profile.get("role"):
        head.append(f"role: {profile['role']}")
    if profile.get("company"):
        head.append(f"company: {profile['company']}")
    block = ""
    if head:
        block += "; ".join(head) + ". "
    if parts:
        block += "Known entities: " + " ; ".join(parts) + "."
    return ("\n" + block) if block else ""


def _linking_schema() -> dict:
    s = _copy.deepcopy(EXTRACTION_JSON_SCHEMA)
    s["name"] = "conversation_intelligence_linked"
    ent = s["schema"]["properties"]["entities"]["items"]
    ent["properties"]["candidate_id"] = {"type": ["string", "null"]}
    ent["properties"]["links_to_profile"] = {"type": "string", "enum": ["known", "new", "unsure"]}
    ent["required"] = ent["required"] + ["candidate_id", "links_to_profile"]
    return s


CONTEXT_LINKING_SCHEMA = _linking_schema()


async def combined_with_context(provider, transcript, sample=None):
    profile = (sample or {}).get("profile")
    system = COMBINED_SYSTEM + ENTITY_GUIDANCE + PRIORS_PREAMBLE + render_known_entities(profile)
    d = await provider.extract(EXTRACTION_JSON_SCHEMA, system, transcript)
    return {"entities": d.get("entities", []) or [], "action_items": d.get("action_items", []) or []}


async def combined_with_context_linking(provider, transcript, sample=None):
    profile = (sample or {}).get("profile")
    system = COMBINED_SYSTEM + ENTITY_GUIDANCE + PRIORS_PREAMBLE + LINKING_INSTRUCTION + render_known_entities(profile)
    d = await provider.extract(CONTEXT_LINKING_SCHEMA, system, transcript)
    return {"entities": d.get("entities", []) or [], "action_items": d.get("action_items", []) or []}


STRATEGIES["combined_with_context"] = combined_with_context
STRATEGIES["combined_with_context_linking"] = combined_with_context_linking
