import { getSettings, insertConversation, setTurnsConversation, unsegmentedTurns } from "./repo";

const toks = (t: string) => new Set((t.toLowerCase().match(/\w+/g) ?? []));
function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 1;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export async function segmentSession(sessionId: number): Promise<number[]> {
  const s = await getSettings();
  const gap = Number(s["segment_gap_seconds"] ?? 300);
  const topic = String(s["segment_topic_shift"] ?? "off") === "on";
  const minTurns = Number(s["segment_min_turns"] ?? 8);
  const minSecs = Number(s["segment_min_seconds"] ?? 90);
  const turns = await unsegmentedTurns(sessionId);
  if (!turns.length) return [];
  const starts = [0];
  const block = 5;
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1] as any, cur = turns[i] as any;
    const dt = prev.abs_start && cur.abs_start
      ? (Date.parse(cur.abs_start) - Date.parse(prev.abs_start)) / 1000 : 0;
    const lastStart = starts[starts.length - 1];
    const segTurns = i - lastStart;
    const segSecs = (cur.abs_start && turns[lastStart].abs_start)
      ? (Date.parse(cur.abs_start) - Date.parse(turns[lastStart].abs_start)) / 1000 : 0;
    const bigEnough = segTurns >= minTurns || segSecs >= minSecs;
    if (dt >= gap && bigEnough) { starts.push(i); continue; }
    if (topic && bigEnough && i - starts[starts.length - 1] >= 2 * block) {
      const a = new Set<string>(); turns.slice(Math.max(starts[starts.length - 1], i - block), i).forEach((t: any) => toks(t.text).forEach((x) => a.add(x)));
      const b = new Set<string>(); turns.slice(i, i + block).forEach((t: any) => toks(t.text).forEach((x) => b.add(x)));
      if (b.size && jaccard(a, b) < 0.05) starts.push(i);
    }
  }
  const bounds = [...starts, turns.length];
  const convIds: number[] = [];
  for (let k = 0; k < starts.length; k++) {
    const group = turns.slice(bounds[k], bounds[k + 1]) as any[];
    if (!group.length) continue;
    const participants = [...new Set(group.map((t) => t.person_id).filter((x) => x != null))];
    const convId = await insertConversation({
      session_id: sessionId, started_at: group[0].abs_start, ended_at: group[group.length - 1].abs_start, participant_person_ids: participants,
    });
    await setTurnsConversation(group.map((t) => t.id), convId);
    convIds.push(convId);
  }
  return convIds;
}
