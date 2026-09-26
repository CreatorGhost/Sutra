// Mirrors backend/app/services/extraction.py + chat.py prompts/schemas (kept in sync; client owns the
// prompt, the proxy is a thin OpenAI wrapper). PROMPT_VERSION is stamped on captured training samples.
export const PROMPT_VERSION = "extract-v5"; // v5: + subtitle (one-line gist) + open_questions for meeting notes

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
  "Also fill subtitle: ONE short sentence (max ~15 words) giving the gist, e.g. 'Team synced on monitoring " +
  "setup, findings visibility problems, and demo user access bugs.' The title is a short, specific headline " +
  "(3-7 words, no quotes, no trailing period). Also fill open_questions: questions raised but NOT resolved " +
  "in the conversation, phrased as questions; empty list if none.";

const ENTITY_TYPES = ["person", "project", "topic", "org", "place", "event", "commitment"];

export const EXTRACTION_JSON_SCHEMA = {
  name: "conversation_intelligence",
  strict: true,
  schema: obj({
    title: { type: "string" },
    subtitle: { type: "string" },
    summary: { type: "string" },
    participants: { type: "array", items: { type: "string" } },
    facts: { type: "array", items: { type: "string" } },
    action_items: { type: "array", items: obj(
      { text: { type: "string" }, owner: { type: ["string", "null"] }, due: { type: ["string", "null"] },
        steps: { type: "array", items: { type: "string" } } },
      ["text", "owner", "due", "steps"]) },
    decisions: { type: "array", items: { type: "string" } },
    open_questions: { type: "array", items: { type: "string" } },
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
  }, ["title", "subtitle", "summary", "participants", "facts", "action_items", "decisions", "open_questions", "entities", "relations", "importance_score", "type_tags", "speaker_names", "events"]),
};

export const CHAT_SYSTEM =
  "You are Sutra, the user's personal memory. Answer ONLY from the provided context (memories + a " +
  "knowledge-graph neighborhood). If the context does not contain the answer, set supported=false and say " +
  "you don't have a record — never invent facts. Cite the conversation ids you used. The source material " +
  "may be Hindi-English; answer in the user's language.";

export const ANSWER_SCHEMA = {
  name: "grounded_answer", strict: true,
  schema: obj({
    answer: { type: "string" },
    supported: { type: "boolean" },
    citation_conversation_ids: { type: "array", items: { type: "integer" } },
  }, ["answer", "supported", "citation_conversation_ids"]),
};

// ---- Meeting notes (Detailed style) + per-meeting Q&A --------------------------------------------
// "Brief" notes need no extra call — they are the extraction above (summary, decisions, action items,
// open questions). "Detailed" is generated on demand and cached in the notes table.

export const NOTES_DETAILED_SYSTEM =
  "You write thorough, well-structured meeting notes from a transcript. The transcript may be Hindi-English " +
  "code-switched; write the notes in clear English, keeping names and product terms as spoken. Group the " +
  "discussion into topics in the order they came up; each topic gets a short heading and 2-6 concise bullet " +
  "points with the concrete details (numbers, names, reasons, blockers). Then list decisions, action items " +
  "(owner = the person responsible, or null), open questions and next steps. Only use what is in the " +
  "transcript — never invent. Use empty lists when a section has nothing.";

export const NOTES_DETAILED_SCHEMA = {
  name: "detailed_notes",
  strict: true,
  schema: obj({
    overview: { type: "string" },
    topics: { type: "array", items: obj({ heading: { type: "string" }, points: { type: "array", items: { type: "string" } } }, ["heading", "points"]) },
    decisions: { type: "array", items: { type: "string" } },
    action_items: { type: "array", items: obj({ text: { type: "string" }, owner: { type: ["string", "null"] } }, ["text", "owner"]) },
    open_questions: { type: "array", items: { type: "string" } },
    next_steps: { type: "array", items: { type: "string" } },
  }, ["overview", "topics", "decisions", "action_items", "open_questions", "next_steps"]),
};

export const ASK_MEETING_SYSTEM =
  "You answer questions about ONE meeting using only its notes and transcript below. Be direct and brief " +
  "(1-4 sentences or a short list). Quote who said what when it helps. If the meeting doesn't cover it, say " +
  "so plainly — never invent. Answer in the language of the question.";

export const ASK_MEETING_SCHEMA = {
  name: "meeting_answer",
  strict: true,
  schema: obj({ answer: { type: "string" } }, ["answer"]),
};
