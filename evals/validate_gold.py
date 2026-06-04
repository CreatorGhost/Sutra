"""Validate the eval gold set: schema, id uniqueness, and required coverage for the
profile A/B (aliases, Devanagari spellings, genuinely-new-person cases, prior-handling probes).

    python -m evals.validate_gold        # exits non-zero if any hard check fails
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

GOLD_DIR = pathlib.Path(__file__).parent / "gold"
ENTITY_TYPES = {"person", "project", "topic", "org", "place", "event", "commitment"}
DEVANAGARI = re.compile(r"[ऀ-ॿ]")


def _profile_names(p: dict) -> set[str]:
    """All canonical names + aliases declared in a sample's profile, lowercased."""
    names: set[str] = set()
    for bucket in ("people", "projects", "orgs", "places"):
        for it in (p.get(bucket) or []):
            if it.get("name"):
                names.add(it["name"].strip().lower())
            for a in (it.get("aliases") or []):
                names.add(a.strip().lower())
    for k in ("role", "company"):
        if p.get(k):
            names.add(str(p[k]).strip().lower())
    return names


def main() -> int:
    errors: list[str] = []
    warnings: list[str] = []
    rows: list[dict] = []
    for f in sorted(GOLD_DIR.glob("*.jsonl")):
        for ln, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append({"_file": f.name, "_ln": ln, **json.loads(line)})
            except json.JSONDecodeError as e:
                errors.append(f"{f.name}:{ln} invalid JSON: {e}")

    ids: dict[str, str] = {}
    n_profile = n_novel_ent = n_with_novel = n_deva = n_alias_profiles = 0
    probes: dict[str, int] = {}
    langs: dict[str, int] = {}

    for r in rows:
        loc = f"{r['_file']}:{r['_ln']}"
        sid = r.get("id")
        if not sid:
            errors.append(f"{loc} missing id")
        elif sid in ids:
            errors.append(f"{loc} duplicate id '{sid}' (also in {ids[sid]})")
        else:
            ids[sid] = loc
        langs[r.get("lang", "?")] = langs.get(r.get("lang", "?"), 0) + 1

        for t in (r.get("transcript") or []):
            if "speaker" not in t or "text" not in t:
                errors.append(f"{loc} transcript turn missing speaker/text")
        if DEVANAGARI.search(line_of := json.dumps(r, ensure_ascii=False)):
            n_deva += 1

        exp = r.get("expected") or {}
        ents = exp.get("entities") or []
        if not ents:
            warnings.append(f"{loc} no expected entities")
        prof = r.get("profile")
        prof_names = _profile_names(prof) if prof else set()
        if prof:
            n_profile += 1
            if any((it.get("aliases") for b in ("people", "projects", "orgs") for it in (prof.get(b) or []))):
                n_alias_profiles += 1

        sample_has_novel = False
        for e in ents:
            if "name" not in e or "type" not in e:
                errors.append(f"{loc} entity missing name/type: {e}")
                continue
            if e["type"] not in ENTITY_TYPES:
                errors.append(f"{loc} entity '{e['name']}' bad type '{e['type']}'")
            nm = e["name"].strip().lower()
            if e.get("novel"):
                n_novel_ent += 1
                sample_has_novel = True
                # A novel entity must NOT already be declared in the profile (else it isn't novel).
                if nm in prof_names:
                    errors.append(f"{loc} entity '{e['name']}' marked novel but is in the profile")
            else:
                # A non-novel, non-owner entity should generally be a known prior (soft check).
                if prof and nm != "me" and nm not in prof_names and e["type"] in ("person", "project", "org"):
                    warnings.append(f"{loc} '{e['name']}' not novel and not in profile")
        if sample_has_novel:
            n_with_novel += 1
        if r.get("probe"):
            probes[r["probe"]] = probes.get(r["probe"], 0) + 1

    total = len(rows)
    print("=" * 70)
    print(f"GOLD VALIDATION  ({total} samples across {len(set(r['_file'] for r in rows))} files)")
    print("=" * 70)
    print(f"by lang          : {dict(sorted(langs.items()))}")
    print(f"with profile     : {n_profile}")
    print(f"profiles w/alias : {n_alias_profiles}")
    print(f"Devanagari lines : {n_deva}")
    print(f"novel entities   : {n_novel_ent} across {n_with_novel} samples")
    print(f"prior probes     : {dict(sorted(probes.items()))}")
    print("-" * 70)

    # Hard coverage gates for the A/B design
    gates = {
        ">=50 samples": total >= 50,
        ">=40 with profile": n_profile >= 40,
        ">=20 samples with a novel person/entity": n_with_novel >= 20,
        ">=8 Devanagari samples": n_deva >= 8,
        ">=6 alias-bearing profiles": n_alias_profiles >= 6,
        "staleness probe present": probes.get("staleness", 0) >= 1,
        "contradiction probe present": probes.get("contradiction", 0) >= 1,
    }
    for name, ok in gates.items():
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
        if not ok:
            errors.append(f"coverage gate failed: {name}")

    if warnings:
        print("-" * 70)
        print(f"{len(warnings)} warning(s) (soft):")
        for w in warnings[:15]:
            print(f"  ! {w}")
        if len(warnings) > 15:
            print(f"  ... and {len(warnings) - 15} more")

    print("-" * 70)
    if errors:
        print(f"FAILED with {len(errors)} error(s):")
        for e in errors[:30]:
            print(f"  x {e}")
        return 1
    print("OK — all hard checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
