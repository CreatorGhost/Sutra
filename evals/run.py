"""Run the eval harness against a provider. Reuses the app's real extraction prompt+schema.

  python -m evals.run                 # uses AI_PROVIDER from env (cloud by default)
Prints metrics OVERALL and for the Hinglish (hi-en) subset, and writes results/<provider>-<ts>.json
with model_id + prompt_version (corpus versioning). A model may become a default only if it clears
the bar on the hi-en subset: action-item F1 >= 0.90 x cloud baseline AND CER <= 1.2 x cloud baseline.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import pathlib
import statistics as stats

from app.config import settings
from app.providers import get_provider
from app.schemas import EXTRACTION_JSON_SCHEMA
from app.services.extraction import PROMPT_VERSION, SYSTEM as EXTRACT_SYSTEM
from evals.metrics import action_item_prf, discovery_canonical_metrics, entity_f1, wer_cer
from evals.strategies import STRATEGIES

GOLD_DIR = pathlib.Path(__file__).parent / "gold"
RESULTS_DIR = pathlib.Path(__file__).parent / "results"


def load_gold() -> list[dict]:
    out: list[dict] = []
    for f in sorted(GOLD_DIR.glob("*.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                out.append(json.loads(line))
    for f in sorted(GOLD_DIR.glob("*.json")):
        out.append(json.loads(f.read_text(encoding="utf-8")))
    return out


async def run_sample(provider, s: dict, strategy) -> dict:
    transcript_text = "\n".join(f"{t['speaker']}: {t['text']}" for t in s["transcript"])
    res = {"id": s["id"], "lang": s.get("lang", "unknown")}
    if s.get("audio"):  # ASR metrics only when audio gold is provided
        try:
            audio = pathlib.Path(s["audio"]).read_bytes()
            tr = await provider.transcribe_diarize(audio, pathlib.Path(s["audio"]).name, "audio/m4a")
            hyp = " ".join(seg["text"] for seg in tr["segments"]) or tr.get("text", "")
            ref = " ".join(t["text"] for t in s["transcript"])
            res["wer"], res["cer"] = wer_cer(ref, hyp)
        except Exception as e:
            res["asr_error"] = str(e)[:200]
    out = await strategy(provider, transcript_text, s)
    exp = s.get("expected", {})
    res["entity_f1"] = entity_f1(out["entities"], exp.get("entities", []) or [])
    res["action"] = action_item_prf(out["action_items"], exp.get("action_items", []) or [])
    res["discovery"] = discovery_canonical_metrics(out["entities"], exp.get("entities", []) or [], s.get("profile"))
    return res


def _avg(xs):
    xs = [x for x in xs if x is not None]
    return round(stats.fmean(xs), 4) if xs else None


def aggregate(rows: list[dict], lang: str | None = None) -> dict:
    g = [r for r in rows if lang is None or r["lang"] == lang]
    return {
        "n": len(g),
        "entity_f1": _avg([r["entity_f1"]["f1"] for r in g if "entity_f1" in r]),
        "action_f1": _avg([r["action"]["f1"] for r in g if "action" in r]),
        "action_precision": _avg([r["action"]["precision"] for r in g if "action" in r]),
        "action_recall": _avg([r["action"]["recall"] for r in g if "action" in r]),
        "cer": _avg([r.get("cer") for r in g]),
        "wer": _avg([r.get("wer") for r in g]),
        "known_recall": _avg([r["discovery"]["known_recall"] for r in g if "discovery" in r]),
        "new_precision": _avg([r["discovery"]["new_precision"] for r in g if "discovery" in r]),
        "new_recall": _avg([r["discovery"]["new_recall"] for r in g if "discovery" in r]),
    }


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--strategy", default="combined", choices=list(STRATEGIES.keys()))
    args = ap.parse_args()
    strategy = STRATEGIES[args.strategy]
    provider = get_provider()
    gold = load_gold()
    if not gold:
        print("No gold samples in evals/gold/. Add .jsonl/.json samples (see evals/README.md).")
        return
    rows = []
    for s in gold:
        rows.append(await run_sample(provider, s, strategy))

    overall = aggregate(rows)
    hinglish = aggregate(rows, "hi-en")
    en = aggregate(rows, "en")

    RESULTS_DIR.mkdir(exist_ok=True)
    stamp = "run"  # caller can rename; new Date() is fine here (normal runtime, not a workflow)
    payload = {
        "provider": settings.ai_provider,
        "model_extract": settings.model_extract,
        "model_transcribe": settings.model_transcribe,
        "prompt_version": PROMPT_VERSION,
        "strategy": args.strategy,
        "n_samples": len(gold),
        "overall": overall, "hinglish_hi_en": hinglish, "english_en": en,
        "per_sample": rows,
    }
    try:
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    except Exception:
        pass
    outpath = RESULTS_DIR / f"{settings.ai_provider}-{settings.model_extract}-{stamp}.json"
    outpath.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def fmt(d):
        return (f"n={d['n']:<2} entityF1={d['entity_f1']}  actionF1={d['action_f1']} "
                f"(P={d['action_precision']}/R={d['action_recall']})  CER={d['cer']}\n"
                f"                 canon knownR={d['known_recall']}   discovery newP={d['new_precision']} newR={d['new_recall']}")

    print("\n" + "=" * 78)
    print(f"EVAL  provider={settings.ai_provider}  extract={settings.model_extract}  strategy={args.strategy}  prompt={PROMPT_VERSION}")
    print("=" * 78)
    print(f"OVERALL        : {fmt(overall)}")
    print(f"HINGLISH hi-en : {fmt(hinglish)}   <-- the gate is set against THIS subset")
    print(f"ENGLISH  en    : {fmt(en)}")
    print("-" * 78)
    print(f"results -> {outpath}")


if __name__ == "__main__":
    asyncio.run(main())
