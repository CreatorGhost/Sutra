/**
 * Pure, dependency-free turn coalescing used at READ time only.
 * Merges consecutive same-speaker diarization turns into coherent turns.
 * Never mutates stored rows; input is assumed sorted by window_index, start_ts, id.
 */

export interface RawTurn {
  id: number; session_speaker_label: string; person_id?: number | null;
  person_name?: string | null; is_me?: number | boolean | null;
  text: string; lang?: string | null;
  start_ts: number; end_ts?: number | null; abs_start?: string | null;
  window_index?: number | null; redacted?: number | boolean | null;
  [k: string]: unknown;
}

export interface CoalescedTurn extends RawTurn { member_ids: number[]; }

export interface CoalesceOpts { maxGapS: number; maxMergeWords: number; crossWindow: boolean; }

const wordCount = (s: string) => (s.match(/\S+/g) || []).length;

function gapBetween(run: RawTurn, cur: RawTurn): number {
  if ((run.window_index ?? 0) === (cur.window_index ?? 0)) {
    return cur.start_ts - (run.end_ts ?? run.start_ts);
  }
  if (run.abs_start && cur.abs_start) {
    return (Date.parse(cur.abs_start) - (Date.parse(run.abs_start) + ((run.end_ts ?? run.start_ts) - run.start_ts) * 1000)) / 1000;
  }
  return 0;
}

function sameSpeaker(run: RawTurn, cur: RawTurn): boolean {
  if (run.person_id != null && cur.person_id != null) return run.person_id === cur.person_id;
  return run.session_speaker_label === cur.session_speaker_label;
}

export function coalesceTurns(turns: RawTurn[], opts: CoalesceOpts): CoalescedTurn[] {
  const out: CoalescedTurn[] = [];
  for (const cur of turns) {
    const run = out[out.length - 1];
    const mergeable = run != null
      && sameSpeaker(run, cur)
      && (opts.crossWindow || (run.window_index ?? 0) === (cur.window_index ?? 0))
      && gapBetween(run, cur) <= opts.maxGapS
      && wordCount(run.text) < opts.maxMergeWords
      && !!run.redacted === !!cur.redacted;
    if (mergeable) {
      run.text = (run.text + " " + cur.text).trim();
      run.end_ts = cur.end_ts ?? run.end_ts;
      run.member_ids.push(cur.id);
    } else {
      out.push({ ...cur, member_ids: [cur.id] });
    }
  }
  return out;
}
