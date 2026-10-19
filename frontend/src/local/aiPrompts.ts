// Mirrors backend/app/services/extraction.py + chat.py prompts/schemas (kept in sync; client owns the
// prompt, the proxy is a thin OpenAI wrapper). PROMPT_VERSION is stamped on captured training samples.
export const PROMPT_VERSION = "extract-v6"; // v6: is_meeting (drives Minutes) + subtitle + open_questions

const obj = (props: object, required: string[]) =>
  ({ type: "object", properties: props, required, additionalProperties: false });

/** How the owner's lines are recorded — so echo on their mic doesn't make the model doubt their real words. */
const OWNER_MIC =
  " The speaker marked \"(me)\" is the device owner, recorded from their own microphone; only that exact marker identifies the owner (other people's names never contain brackets). If the " +
  "owner's mic picked up the call through speakers, some of their lines are near-copies of what someone else " +
  "said at the same moment: treat those as the other person's words, and every line that is NOT such a copy as " +
  "the owner's own (e.g. their update).";

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
  "planning) — and false for casual chat, a monologue/voice-note, or ambient one-sided audio. " +
  "Also fill subtitle: ONE short sentence (max ~15 words) giving the gist, e.g. 'Team synced on monitoring " +
  "setup, findings visibility problems, and demo user access bugs.' The title is a short, specific headline " +
  "(3-7 words, no quotes, no trailing period). Also fill open_questions: questions raised but NOT resolved " +
  "in the conversation, phrased as questions; empty list if none." + OWNER_MIC;

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
    is_meeting: { type: "boolean" },
  }, ["title", "subtitle", "summary", "participants", "facts", "action_items", "decisions", "open_questions", "entities", "relations", "importance_score", "type_tags", "speaker_names", "events", "is_meeting"]),
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
  "remain conversation ids only. If you have the project's code folder (you'll be told), you may also read it " +
  "to answer questions about the code — name the files you used in the answer; citations stay conversation ids. " +
  "'# Related meetings' are linked to the question through the knowledge graph and may come from other projects: " +
  "when one shows the user already worked on, decided or built something relevant, say so and where (e.g. \"you " +
  "built something similar in <project> — [C12]\"); ignore them when they don't help.";

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
  "transcript — never invent. Use empty lists when a section has nothing." + OWNER_MIC;

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
  "so plainly — never invent. Answer in the language of the question. Use Markdown where it helps (short " +
  "lists, **bold** for key facts, `code` for names and paths). If you have the project's code folder " +
  "(you'll be told), you may also read it to answer questions about the code, naming the files you used. " +
  "Cite where each point comes from, inline, right after it: the transcript time in brackets exactly as shown " +
  "(e.g. [12:34]) for something said, and the screenshot tag (e.g. [img:7]) for something seen on screen. Only " +
  "cite times and tags that appear below; never make one up." + OWNER_MIC;

export const ASK_MEETING_SCHEMA = {
  name: "meeting_answer",
  strict: true,
  schema: obj({ answer: { type: "string" } }, ["answer"]),
};
