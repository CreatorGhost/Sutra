"""Verify server-side per-turn ECAPA voiceprints BEFORE wiring speaker-ID into the app.

Sends a real audio clip to the proxy's /transcribe?voiceprints=true (audio in-flight only), then
analyzes the returned per-turn 192-d vectors: prints the cosine matrix, and greedy-clusters the turns
at several thresholds so we can SEE whether voiceprints recover the true speakers (e.g. split the two
voices the cloud diarizer merged) and pick the cluster/accept thresholds.

    python3 -m evals.voiceprint_check /path/to/clip.m4a [--proxy http://localhost:8787]

Pure stdlib + httpx (no numpy needed). Nothing is written; the proxy never persists the audio.
"""
from __future__ import annotations

import argparse
import math
import os

import httpx


def cos(a: list[float], b: list[float]) -> float:
    d = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return d / (na * nb) if na and nb else 0.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--proxy", default="http://localhost:8787")
    args = ap.parse_args()

    name = os.path.basename(args.audio)
    with open(args.audio, "rb") as f:
        r = httpx.post(args.proxy + "/transcribe",
                       files={"file": (name, f, "audio/m4a")},
                       data={"voiceprints": "true"}, timeout=600)
    r.raise_for_status()
    segs = r.json().get("segments", []) or []
    emb = [(i, s.get("speaker"), (s.get("text") or "")[:48], s["embedding"])
           for i, s in enumerate(segs) if s.get("embedding")]

    print(f"{len(segs)} turns total; {len(emb)} embeddable (>=0.6s). Cloud-diarizer labels shown in []\n")
    for i, s in enumerate(segs):
        tag = "(emb)" if s.get("embedding") else "(short/null)"
        print(f"  t{i:<2} [{s.get('speaker')}] {tag:<12} {(s.get('text') or '')[:60]}")

    if len(emb) < 2:
        print("\nNot enough embeddable turns to compare. Record a longer clip with clearer turns.")
        return 1

    print("\nPairwise cosine (embeddable turns):")
    print("      " + "  ".join(f"t{i}" for i, _, _, _ in emb))
    for i, _, _, ei in emb:
        print(f"  t{i:<3}" + "  ".join(f"{cos(ei, ej):+.2f}" for _, _, _, ej in emb))

    # --- faithful simulation of the SHIPPED on-device algorithm (frontend/src/local/speakerId.ts) ---
    # Agglomerative (average-linkage) over confident (>=1.2s, non-empty) turns: merge the closest two
    # clusters while centroid cosine >= 0.45; prune singletons; assign EVERY embedded turn to nearest
    # surviving cluster; carry short turns forward/back. Cloud [labels] should map ~1:1 onto clusters.
    SEED_MIN, MERGE, MIN_TURNS = 1.2, 0.45, 2
    from collections import Counter

    def mean_vec(vs):
        dim = len(vs[0]); out = [0.0] * dim
        for v in vs:
            for k in range(dim): out[k] += v[k]
        out = [x / len(vs) for x in out]
        n = math.sqrt(sum(x * x for x in out))
        return [x / n for x in out] if n else out

    def nearest(cents, v):
        bi, best = 0, -1e9
        for i, c in enumerate(cents):
            s = cos(v, c)
            if s > best: best, bi = s, i
        return bi

    emb_rows = [(i, s) for i, s in enumerate(segs) if s.get("embedding") and (s.get("text") or "").strip()]
    long_rows = [(i, s) for i, s in emb_rows if (s.get("end", 0) - s.get("start", 0)) >= SEED_MIN]
    seed_rows = long_rows if len(long_rows) >= 2 else emb_rows
    groups = [[s["embedding"]] for _, s in seed_rows]
    cents = [list(s["embedding"]) for _, s in seed_rows]
    while len(groups) > 1:
        bi = bj = -1; best = -1e9
        for i in range(len(cents)):
            for j in range(i + 1, len(cents)):
                sm = cos(cents[i], cents[j])
                if sm > best: best, bi, bj = sm, i, j
        if best < MERGE: break
        groups[bi] = groups[bi] + groups[bj]; del groups[bj]
        cents[bi] = mean_vec(groups[bi]); del cents[bj]
    kept = list(zip(groups, cents))
    real = [k for k in kept if len(k[0]) >= MIN_TURNS]
    if real: kept = real
    kept.sort(key=lambda k: -len(k[0]))
    labels = [str(i + 1) for i in range(len(kept))]
    fcents = [k[1] for k in kept]

    label_of: dict[int, str] = {}
    for i, s in emb_rows:
        label_of[i] = labels[nearest(fcents, s["embedding"])]
    carry = None
    for i in range(len(segs)):
        if i in label_of: carry = label_of[i]
        elif carry: label_of[i] = carry
    emb_idx = {i for i, _ in emb_rows}
    back = None
    for i in range(len(segs) - 1, -1, -1):
        if i in emb_idx: back = label_of.get(i)
        elif i not in label_of and back: label_of[i] = back

    print(f"\n=== SHIPPED on-device algorithm → {len(kept)} speaker(s) recovered ===")
    by_cluster: dict[str, list[int]] = {}
    for i, lbl in label_of.items(): by_cluster.setdefault(lbl, []).append(i)
    for lbl in labels:
        mem = by_cluster.get(lbl, [])
        print(f"  cluster {lbl}: {len(mem)} turns; cloud labels {dict(Counter(segs[i].get('speaker') for i in mem))}")
    correct = sum(Counter(segs[i].get("speaker") for i in ids).most_common(1)[0][1] for ids in by_cluster.values())
    print(f"  cluster purity vs cloud diarizer: {correct}/{len(label_of)} = {correct/max(1,len(label_of)):.0%}")

    print("\nGreedy clustering by threshold (does it recover the true speakers?):")
    for thr in (0.35, 0.45, 0.55, 0.65):
        clusters: list[dict] = []
        for i, sp, txt, ei in emb:
            best, bi = -1.0, -1
            for ci, c in enumerate(clusters):
                sim = cos(ei, c["centroid"])
                if sim > best:
                    best, bi = sim, ci
            if best >= thr:
                c = clusters[bi]; c["members"].append((i, txt))
                n = len(c["members"])
                c["centroid"] = [(c["centroid"][k] * (n - 1) + ei[k]) / n for k in range(len(ei))]
            else:
                clusters.append({"centroid": list(ei), "members": [(i, txt)]})
        print(f"\n  thr {thr}: {len(clusters)} speaker(s)")
        for ci, c in enumerate(clusters):
            print(f"    S{ci}: " + " | ".join(f"t{m[0]}:{m[1][:24]}" for m in c["members"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
