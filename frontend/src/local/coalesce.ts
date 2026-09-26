// Read-time transcript coalescing: the diarizer emits many short fragments per speaker; for display
// and extraction we merge consecutive fragments from the same speaker into one readable paragraph.
// PURE — never mutates stored rows (the raw turns stay the source of truth).

export interface CoalescibleTurn {
  id: number;
  session_speaker_label?: string | null;
  person_id?: number | null;
  text: string;
  start_ts?: number | null;
  end_ts?: number | null;
  window_index?: number | null;
  [k: string]: unknown;
}

export interface CoalesceOpts {
  /** Merge only when the silence between fragments is at most this many seconds (same window). */
  maxGapS?: number;
  /** Stop growing a paragraph once it reaches this many words. */
  maxMergeWords?: number;
  /** Allow merging across capture windows (only safe once speakers are stabilised to person_ids). */
  crossWindow?: boolean;
}

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

function sameSpeaker(a: CoalescibleTurn, b: CoalescibleTurn): boolean {
  if (a.person_id != null || b.person_id != null) return a.person_id === b.person_id;
  return (a.session_speaker_label ?? "") === (b.session_speaker_label ?? "");
}

export function coalesceTurns<T extends CoalescibleTurn>(
  turns: T[],
  { maxGapS = 2, maxMergeWords = 400, crossWindow = false }: CoalesceOpts = {},
): (T & { turn_ids: number[] })[] {
  const out: (T & { turn_ids: number[] })[] = [];
  for (const t of turns) {
    const text = String(t.text ?? "").trim();
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev && sameSpeaker(prev, t)) {
      const sameWindow = (prev.window_index ?? 0) === (t.window_index ?? 0);
      const gap = sameWindow && t.start_ts != null && prev.end_ts != null ? Number(t.start_ts) - Number(prev.end_ts) : 0;
      const fits = words(prev.text) + words(text) <= maxMergeWords;
      if ((sameWindow ? gap <= maxGapS : crossWindow) && fits) {
        prev.text = `${prev.text} ${text}`;
        if (sameWindow) prev.end_ts = t.end_ts ?? prev.end_ts;
        prev.turn_ids.push(t.id);
        continue;
      }
    }
    out.push({ ...t, text, turn_ids: [t.id] });
  }
  return out;
}
