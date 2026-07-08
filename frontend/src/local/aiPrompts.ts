// Mirrors backend/app/services/extraction.py + chat.py prompts/schemas (kept in sync; client owns the
// prompt, the proxy is a thin OpenAI wrapper). PROMPT_VERSION is stamped on captured training samples.
export const PROMPT_VERSION = "extract-v5"; // v5: + is_meeting flag (drives Minutes-of-Meeting generation)

const obj = (props: object, required: string[]) =>
  ({ type: "object", properties: props, required, additionalProperties: false });

export const EXTRACT_SYSTEM =
  "You extract durable memory from a conversation transcript. The transcript is often Hindi-English " +
  "code-switched (Hinglish) — read both languages fluently and DO NOT translate; write the summary in " +
  "clear English but keep proper nouns as spoken. Identify concrete action items (with owner and due " +
  "date if stated), explicit decisions, key facts, and the real-world entities (people, projects, topics, " +
  "orgs, places, events, commitments) plus relationships. importance_score in [0,1]: higher for " +
  "decisions/commitments/plans. Use 'Me' for the device owner when known. " +
  "Extract action items exactly as before — one item per distinct task; do not drop or merge any. For " +
  "each item ADDITIONALLY fill steps with the ordered sub-steps or details discussed for that task, " +
  "grounded in the transcript (do NOT invent; use an empty list if none); never move a separate action " +
  "item into another item's steps. " +
  "Also fill speaker_names: for each speaker label in the transcript (e.g. 'Speaker A'), give that person's " +
  "real name ONLY from in-conversation evidence — a self-introduction ('I am Farha' / 'This is Farha' -> that " +
  "speaker, confidence 'high', basis 'self_introduction'), or being addressed/named by another speaker " +
  "('Hey Mark', 'Mark, can you...' -> the speaker being addressed, usually the OTHER party, confidence 'low', " +
  "basis 'addressed_by_other'). Use 'Me' for the device owner if identifiable. If a speaker cannot be named " +
  "from the transcript, set name null and basis 'unknown'. Never guess a name. " +
  "Also fill events: every scheduled or time-bound thing discussed — meetings, calls, deadlines, " +
  "appointments, or time-bound commitments (e.g. 'kal 11 baje meeting hai', 'at 5pm I'll send the files'). " +
  "For each event give title (what it is), when (the date/time EXACTLY as spoken), datetime (resolved to " +
  "ISO 8601 'YYYY-MM-DDTHH:MM' relative to the 'Today's date' line at the top of the transcript; null only " +
  "if it genuinely cannot be resolved), and kind (one of meeting, call, deadline, reminder, other). Only " +
  "extract times actually mentioned; never invent. " +
  "Also set is_meeting: true if this transcript is a MEETING or working discussion — two or more people " +
  "talking through agenda items, updates, decisions, or assigned tasks (standup, sync, call, review, " +
  "planning) — and false for casual chat, a monologue/voice-note, or ambient one-sided audio.";

const ENTITY_TYPES = ["person", "project", "topic", "org", "place", "event", "commitment"];

export const EXTRACTION_JSON_SCHEMA = {
  name: "conversation_intelligence",
  strict: true,
  schema: obj({
    title: { type: "string" },
    summary: { type: "string" },
    participants: { type: "array", items: { type: "string" } },
    facts: { type: "array", items: { type: "string" } },
    action_items: { type: "array", items: obj(
      { text: { type: "string" }, owner: { type: ["string", "null"] }, due: { type: ["string", "null"] },
        steps: { type: "array", items: { type: "string" } } },
      ["text", "owner", "due", "steps"]) },
    decisions: { type: "array", items: { type: "string" } },
    entities: { type: "array", items: obj(
      { name: { type: "string" }, type: { type: "string", enum: ENTITY_TYPES }, description: { type: ["string", "null"] } },
      ["name", "type", "description"]) },
    relations: { type: "array", items: obj(
      { src: { type: "string" }, relation: { type: "string" }, dst: { type: "string" } },
      ["src", "relation", "dst"]) },
    importance_score: { type: "number" },
    type_tags: { type: "array", items: { type: "string", enum: ["decision", "commitment", "factual", "social", "task", "idea"] } },
    speaker_names: { type: "array", items: obj(
      { speaker: { type: "string" }, name: { type: ["string", "null"] },
        basis: { type: "string", enum: ["self_introduction", "addressed_by_other", "named_by_other", "unknown"] },
        confidence: { type: "string", enum: ["high", "low"] } },
      ["speaker", "name", "basis", "confidence"]) },
    events: { type: "array", items: obj(
      { title: { type: "string" }, when: { type: "string" }, datetime: { type: ["string", "null"] },
        kind: { type: "string", enum: ["meeting", "call", "deadline", "reminder", "other"] } },
      ["title", "when", "datetime", "kind"]) },
    is_meeting: { type: "boolean" },
  }, ["title", "summary", "participants", "facts", "action_items", "decisions", "entities", "relations", "importance_score", "type_tags", "speaker_names", "events", "is_meeting"]),
};

// ---- Minutes of Meeting ----
// Generated on demand (or auto, for detected meetings) from a conversation's transcript. Professional,
// faithful minutes — never invents attendees, decisions, or owners not grounded in the transcript.
export const MINUTES_SYSTEM =
  "You write professional Minutes of Meeting from a transcript that may be Hindi-English code-switched. " +
  "Be faithful and concise — summarize what was actually said; NEVER invent attendees, decisions, owners, " +
  "or dates. Write in clear English but keep proper nouns and names as spoken. " +
  "title: a short descriptive meeting title. summary: 1–2 sentences on purpose & outcome. " +
  "attendees: the distinct participants (use their names if known, else 'Speaker A' etc.; do not duplicate). " +
  "agenda: the topics/items the meeting covered, in order. discussion: the key points, updates, and " +
  "context raised per topic (one concise bullet each). decisions: only explicit decisions/agreements. " +
  "action_items: concrete tasks — task (what), owner (who, or null), due (when as stated, or null); one per " +
  "distinct task, do not merge or invent. next_steps: agreed follow-ups not already an action item. " +
  "Leave any list empty if the transcript has nothing for it; do not pad.";

export const MINUTES_JSON_SCHEMA = {
  name: "meeting_minutes",
  strict: true,
  schema: obj({
    title: { type: "string" },
    summary: { type: "string" },
    attendees: { type: "array", items: { type: "string" } },
    agenda: { type: "array", items: { type: "string" } },
    discussion: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    action_items: { type: "array", items: obj(
      { task: { type: "string" }, owner: { type: ["string", "null"] }, due: { type: ["string", "null"] } },
      ["task", "owner", "due"]) },
    next_steps: { type: "array", items: { type: "string" } },
  }, ["title", "summary", "attendees", "agenda", "discussion", "decisions", "action_items", "next_steps"]),
};

export const CHAT_SYSTEM =
  "You are Sutra, the user's personal memory. Answer ONLY from the provided context (memories + a " +
  "knowledge-graph neighborhood). If the context does not contain the answer, set supported=false and say " +
  "you don't have a record — never invent facts. Cite the conversation ids you used. The source material " +
  "may be Hindi-English; answer in the user's language. " +
  "A '# Your Context' block may appear first: these are the user's standing priors (people, projects, " +
  "their role) — use them ONLY to understand who or what the user is referring to. They are NOT facts to " +
  "cite, MAY be stale, and are NOT citable; on any conflict, prefer the memories below them. Citations " +
  "remain conversation ids only.";

export const ANSWER_SCHEMA = {
  name: "grounded_answer", strict: true,
  schema: obj({
    answer: { type: "string" },
    supported: { type: "boolean" },
    citation_conversation_ids: { type: "array", items: { type: "integer" } },
  }, ["answer", "supported", "citation_conversation_ids"]),
};
