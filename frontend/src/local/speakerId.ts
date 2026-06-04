// On-device speaker identity from server-side per-turn ECAPA voiceprints.
//
// The proxy computes one 192-d voiceprint PER TURN from the in-flight audio (vectors only — audio is
// never persisted). Here, on-device, we reconcile those vectors within a session:
//   1) cluster turns by voiceprint so the SAME speaker gets one stable label across windows, AND so
//      speakers the cloud diarizer wrongly MERGED into one label get split apart (the "3 people heard
//      as 2" bug), then
//   2) match each cluster to an enrolled person (Me / someone you named) by centroid cosine, so people
//      auto-tag across sessions.
//
// Thresholds were calibrated on a real 3-speaker Hinglish recording (evals/voiceprint_check.py):
// same-speaker cosine 0.50–0.88, different-speaker 0.10–0.50 (the closest pair still ~0.40 apart from
// the same-speaker floor). Speaker-ID is HYBRID-only; in on-device mode no voiceprints exist so every
// function below cleanly no-ops and turns keep the cloud diarizer's labels.
import * as repo from "./repo";
import { cosine, meanVector } from "./util";

// --- thresholds (see evals/voiceprint_check.py; v1, calibrated on a real 3-speaker Hinglish clip) ---
export const SEED_MIN_SECONDS = 1.2;  // only turns this long are trusted to define a speaker (short = noisy)
export const CLUSTER_MERGE = 0.45;    // agglomerative stop: keep merging the closest two clusters while >= this
export const MIN_CLUSTER_TURNS = 2;   // drop singleton clusters (ECAPA noise on one odd turn) when a real one exists
export const ENROLL_ACCEPT = 0.50;    // a cluster matches an enrolled person if best cos >= this ...
export const ENROLL_MARGIN = 0.10;    // ... AND beats the 2nd-best enrolled person by at least this much

interface Cluster { label: string; centroid: number[]; n: number; }

function nearestIdx(centroids: number[][], v: number[]): number {
  let idx = 0, sim = -Infinity;
  for (let i = 0; i < centroids.length; i++) { const s = cosine(centroids[i], v); if (s > sim) { sim = s; idx = i; } }
  return idx;
}

/** Cluster a session's turns by voiceprint and rewrite each turn's session_speaker_label to a stable
 *  per-session cluster id ("1".."N", largest first). Returns the clusters (label + centroid) for enrolled
 *  matching, or [] when there are <2 embeddable turns (on-device, or a clip too short for any voiceprint).
 *
 *  Agglomerative (average-linkage, order-independent) over the confident turns: start each as its own
 *  cluster and repeatedly merge the closest pair while centroid cosine >= CLUSTER_MERGE. This recovers
 *  the true speaker count from BELOW (splitting cloud-merged speakers) and ABOVE (a flat greedy pass
 *  over-segments noisy turns into junk singletons — measured on the calibration clip). Singletons are
 *  then pruned so one odd ECAPA frame doesn't surface as a phantom speaker. */
export async function clusterSession(sessionId: number): Promise<Cluster[]> {
  const rows = await repo.turnsForClustering(sessionId);
  // Empty-text turns can still carry an embedding (audio with no words) — exclude them; they only add noise.
  const embedded = rows.filter((r) => r.vec && r.vec.length && r.text.trim()) as
    { id: number; text: string; start_ts: number; end_ts: number; vec: number[] }[];
  if (embedded.length < 2) return [];

  // 1) Seeds = the confident (long-enough) turns; fall back to all embedded if every turn is short.
  //    Cap (longest-first) to bound the O(k^3) agglomerative merge on long sessions — the dominant
  //    speakers all have long turns, so the top-N longest still represent every real speaker.
  const longEnough = embedded.filter((r) => r.end_ts - r.start_ts >= SEED_MIN_SECONDS);
  const pool = longEnough.length >= 2 ? longEnough : embedded;
  const seeds = [...pool].sort((a, b) => (b.end_ts - b.start_ts) - (a.end_ts - a.start_ts)).slice(0, 40);

  // 2) Agglomerative merge: groups of member-vectors, centroid = normalized mean. Normalize each seed
  //    up front so the post-merge mean stays a true unit-norm centroid (ECAPA outputs ~unit, not exact).
  let groups: number[][][] = seeds.map((s) => [meanVector([s.vec])]);
  let cents: number[][] = groups.map((g) => g[0].slice());
  while (groups.length > 1) {
    let bi = -1, bj = -1, best = -Infinity;
    for (let i = 0; i < cents.length; i++)
      for (let j = i + 1; j < cents.length; j++) { const s = cosine(cents[i], cents[j]); if (s > best) { best = s; bi = i; bj = j; } }
    if (best < CLUSTER_MERGE) break;
    groups[bi] = groups[bi].concat(groups[bj]); groups.splice(bj, 1);
    cents[bi] = meanVector(groups[bi]); cents.splice(bj, 1);
  }

  // 3) Prune singleton clusters (noise) if any real (>=MIN_CLUSTER_TURNS) cluster survives.
  let kept = groups.map((g, i) => ({ g, c: cents[i] }));
  const real = kept.filter((x) => x.g.length >= MIN_CLUSTER_TURNS);
  if (real.length) kept = real;
  kept.sort((a, b) => b.g.length - a.g.length); // largest speaker = "1"
  const clusters: Cluster[] = kept.map((x, i) => ({ label: String(i + 1), centroid: x.c, n: x.g.length }));
  if (!clusters.length) return [];
  const centroids = clusters.map((c) => c.centroid);

  // 4) Assign EVERY embedded turn to its nearest surviving cluster (no floor — reconciles a speaker
  //    across windows and absorbs the pruned/odd turns into the right speaker).
  const labelOf = new Map<number, string>();
  for (const r of embedded) labelOf.set(r.id, clusters[nearestIdx(centroids, r.vec)].label);

  // 5) Short / no-embedding / empty turns inherit a neighbour's cluster, but ONLY within the same
  //    cloud-diarizer speaker segment — never bleed a label across a speaker boundary.
  let carry: string | null = null, prevCloud: string | null = null;
  for (const r of rows) {
    if (r.cloud !== prevCloud) { carry = null; prevCloud = r.cloud; }
    const lbl = labelOf.get(r.id);
    if (lbl !== undefined) carry = lbl;
    else if (carry) labelOf.set(r.id, carry);
  }
  let back: string | null = null, nextCloud: string | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.cloud !== nextCloud) { back = null; nextCloud = r.cloud; }
    const lbl = labelOf.get(r.id);
    if (lbl !== undefined) back = lbl;
    else if (back) labelOf.set(r.id, back);
  }

  // 6) Persist the new labels, grouped per cluster.
  const byLabel = new Map<string, number[]>();
  for (const [id, lbl] of labelOf) { const a = byLabel.get(lbl) ?? []; a.push(id); byLabel.set(lbl, a); }
  for (const [lbl, ids] of byLabel) await repo.setTurnSpeakerLabel(ids, lbl);
  return clusters;
}

/** Match each cluster centroid to an enrolled person (people.voiceprint) and, on a confident+unambiguous
 *  hit, tag every turn of that cluster with the person. Returns the number of clusters auto-identified. */
export async function matchEnrolledPeople(sessionId: number, clusters: Cluster[]): Promise<number> {
  if (!clusters.length) return 0;
  const people = (await repo.peopleWithVoiceprints()).map((p: any) => ({ id: p.id, vec: Array.from(p.vec) as number[] }))
    .filter((p) => p.vec.length);
  if (!people.length) return 0;
  let matched = 0;
  for (const c of clusters) {
    let best = { id: -1, sim: -1 }, second = -1;
    for (const p of people) {
      const s = cosine(c.centroid, p.vec);
      if (s > best.sim) { second = best.sim; best = { id: p.id, sim: s }; }
      else if (s > second) second = s;
    }
    // Accept on a confident hit that also beats the runner-up by a margin. With a single enrolled
    // person there's no runner-up, so the margin check is vacuous (made explicit, not via second=-1).
    if (best.id !== -1 && best.sim >= ENROLL_ACCEPT && (people.length === 1 || best.sim - second >= ENROLL_MARGIN)) {
      await repo.relabelSpeaker(sessionId, c.label, best.id); // tag all turns of this cluster with the person
      matched++;
    }
  }
  return matched;
}

/** Full session speaker-ID pass: cluster, then auto-tag enrolled people. Best-effort — never throws
 *  (speaker-ID must not block extraction); on-device it no-ops because no voiceprints were captured. */
export async function clusterAndIdentify(sessionId: number): Promise<{ clusters: number; matched: number }> {
  try {
    const clusters = await clusterSession(sessionId);
    const matched = await matchEnrolledPeople(sessionId, clusters);
    return { clusters: clusters.length, matched };
  } catch (e) {
    console.warn("speaker-ID skipped", e);
    return { clusters: 0, matched: 0 };
  }
}
