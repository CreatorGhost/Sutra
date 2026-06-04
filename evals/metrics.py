"""Metrics: WER/CER (ASR), action-item P/R/F1, entity F1. Hinglish-aware normalization."""
from __future__ import annotations

import re

try:
    import jiwer
except Exception:  # optional until audio gold is added
    jiwer = None
from rapidfuzz import fuzz

_DEVANAGARI = "ऀ-ॿ"


def normalize_text(t: str) -> str:
    t = (t or "").lower().strip()
    t = re.sub(rf"[^\w{_DEVANAGARI}\s]", " ", t)  # keep word chars + Devanagari, drop punctuation
    return re.sub(r"\s+", " ", t).strip()


def wer_cer(reference: str, hypothesis: str):
    if jiwer is None:
        return None, None
    r, h = normalize_text(reference), normalize_text(hypothesis)
    if not r:
        return None, None
    return round(float(jiwer.wer(r, h)), 4), round(float(jiwer.cer(r, h)), 4)


def _prf(pred: list, gold: list, key, thresh: int) -> dict:
    """Greedy fuzzy best-match precision/recall/F1."""
    used, tp = set(), 0
    for a in pred:
        best, bj = -1, -1
        for j, b in enumerate(gold):
            if j in used:
                continue
            sc = fuzz.token_set_ratio(key(a), key(b))
            if sc > best:
                best, bj = sc, j
        if best >= thresh and bj >= 0:
            tp += 1
            used.add(bj)
    p = tp / len(pred) if pred else (1.0 if not gold else 0.0)
    r = tp / len(gold) if gold else 1.0
    f = (2 * p * r / (p + r)) if (p + r) else 0.0
    return {"precision": round(p, 3), "recall": round(r, 3), "f1": round(f, 3),
            "tp": tp, "pred": len(pred), "gold": len(gold)}


def entity_f1(pred: list, gold: list) -> dict:
    return _prf(pred, gold, lambda e: normalize_text(e.get("name", "")), 85)


def action_item_prf(pred: list, gold: list) -> dict:
    return _prf(pred, gold, lambda a: normalize_text(a.get("text", "")), 70)


def _profile_name_set(profile: dict | None) -> list[str]:
    """Normalized canonical names + aliases declared in a sample's profile, plus 'me' (owner)."""
    names = ["me"]
    if profile:
        for bucket in ("people", "projects", "orgs", "places"):
            for it in (profile.get(bucket) or []):
                if it.get("name"):
                    names.append(normalize_text(it["name"]))
                for a in (it.get("aliases") or []):
                    names.append(normalize_text(a))
        for k in ("role", "company"):
            if profile.get(k):
                names.append(normalize_text(str(profile[k])))
    return [n for n in names if n]


def _matches_any(name: str, pool: list[str], thresh: int = 85) -> bool:
    return any(fuzz.token_set_ratio(name, p) >= thresh for p in pool if p)


def discovery_canonical_metrics(pred: list, gold: list, profile: dict | None) -> dict:
    """Separate the TWO effects a profile has on extraction, so the A/B can gate on each:

      - known_recall:  fraction of gold KNOWN (non-novel) entities recovered. Rises when the profile
                       helps canonicalize aliases/Devanagari to the listed name. (The intended benefit.)
      - new_recall:    fraction of gold NOVEL entities (NOT in the profile) that the model surfaced
                       AS new (i.e. not collapsed onto a known prior). Drops under 'overshadowing'.
      - new_precision: of the entities the model surfaced that are NOT known priors, the fraction that
                       are real novel entities. Drops if grounding makes the model invent new entities.

    new_* are computed against the profile so baseline and treatment arms are directly comparable."""
    pnames = _profile_name_set(profile)
    pred_names = [normalize_text(e.get("name", "")) for e in pred]
    pred_names = [p for p in pred_names if p]
    gold_known = [normalize_text(e["name"]) for e in gold
                  if not e.get("novel") and normalize_text(e.get("name", "")) != "me"]
    gold_novel = [normalize_text(e["name"]) for e in gold if e.get("novel")]

    known_tp = sum(1 for g in gold_known if _matches_any(g, pred_names))
    known_recall = round(known_tp / len(gold_known), 3) if gold_known else None

    pred_new = [p for p in pred_names if p != "me" and not _matches_any(p, pnames)]
    new_tp = sum(1 for p in pred_new if _matches_any(p, gold_novel))
    new_precision = round(new_tp / len(pred_new), 3) if pred_new else (1.0 if not gold_novel else 0.0)
    novel_found = sum(1 for g in gold_novel if _matches_any(g, pred_new))
    new_recall = round(novel_found / len(gold_novel), 3) if gold_novel else None
    return {
        "known_recall": known_recall, "new_precision": new_precision, "new_recall": new_recall,
        "gold_known": len(gold_known), "gold_novel": len(gold_novel), "pred_new": len(pred_new),
    }
