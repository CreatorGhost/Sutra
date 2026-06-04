import type { Provider } from "../providers/provider";
import { q } from "./db";
import { upsertRollup } from "./repo";

/** Build a per-day rollup on-device. Delivery is a local notification (email is optional/opt-in). */
export async function buildRollup(day: string, provider: Provider) {
  const mems = (await q(
    `SELECT m.summary, m.importance, m.title FROM memories m JOIN conversations c ON c.id=m.conversation_id
     WHERE substr(c.started_at,1,10)=? ORDER BY m.importance DESC`, [day])) as any[];
  const actions = (await q(
    `SELECT ai.text, ai.owner, ai.due FROM action_items ai JOIN conversations c ON c.id=ai.source_conversation
     WHERE ai.status='open' AND substr(c.started_at,1,10)=?`, [day])) as any[];
  const highlights = mems.slice(0, 5).map((m) => `${m.title}: ${m.summary}`);
  const openActions = actions.map((a) => ({ text: a.text, owner: a.owner, due: a.due }));

  let summary: string;
  if (mems.length) {
    const joined = mems.map((m) => `- ${m.title}: ${m.summary}`).join("\n");
    const schema = { name: "day_summary", strict: true, schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false } };
    try { summary = (await provider.chat(schema, "Summarize the day's conversations in 3-4 sentences for a personal recap.", joined)).summary; }
    catch { summary = `${mems.length} conversation(s) today.`; }
  } else summary = "No conversations recorded today.";

  await upsertRollup(day, summary, highlights, openActions);
  return { day, summary, highlights, open_actions: openActions };
}
