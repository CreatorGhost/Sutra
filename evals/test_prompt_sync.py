"""Guard against backend<->frontend extraction-prompt drift.

Production runs the FRONTEND prompt (frontend/src/local/aiPrompts.ts) — the proxy forwards the
client-supplied system+schema verbatim to OpenAI. The eval harness grades the BACKEND prompt
(backend/app/services/extraction.py). If they diverge, the eval measures a prompt that never ships
(this exact bug existed: backend was extract-v1 / no speaker_names while production ran extract-v2).

This test extracts both prompt strings by TEXT parsing (no heavy imports) and asserts they match
after normalization, and that PROMPT_VERSION is identical on both sides.

    python -m evals.test_prompt_sync     # exit 0 if in sync, 1 otherwise
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).parent.parent
BACKEND = ROOT / "backend" / "app" / "services" / "extraction.py"
FRONTEND = ROOT / "frontend" / "src" / "local" / "aiPrompts.ts"

_STR_LIT = re.compile(r'"((?:[^"\\]|\\.)*)"')


def _join_literals(segment: str) -> str:
    parts = [m.group(1) for m in _STR_LIT.finditer(segment)]
    s = "".join(parts)
    return s.replace('\\"', '"').replace("\\\\", "\\")


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def _backend() -> tuple[str, str]:
    # SYSTEM = ( "lit" "lit" ... )  — collect the quoted literals only (a ';'/'(' inside a literal
    # must not terminate the match), so anchor on the run of adjacent string literals.
    txt = BACKEND.read_text(encoding="utf-8")
    ver = re.search(r'PROMPT_VERSION\s*=\s*"([^"]+)"', txt)
    m = re.search(r'\bSYSTEM\s*=\s*\(\s*((?:"(?:[^"\\]|\\.)*"\s*)+)\)', txt, re.DOTALL)
    return (ver.group(1) if ver else ""), _join_literals(m.group(1) if m else "")


def _frontend() -> tuple[str, str]:
    # EXTRACT_SYSTEM = "lit" + "lit" + ... ;  — same: a run of quoted literals joined by '+',
    # ended by the ';' that follows a closing quote (NOT a ';' inside a literal).
    txt = FRONTEND.read_text(encoding="utf-8")
    ver = re.search(r'PROMPT_VERSION\s*=\s*"([^"]+)"', txt)
    m = re.search(r'EXTRACT_SYSTEM\s*=\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+);', txt, re.DOTALL)
    return (ver.group(1) if ver else ""), _join_literals(m.group(1) if m else "")


def main() -> int:
    bver, bsys = _backend()
    fver, fsys = _frontend()
    ok = True
    print(f"backend  PROMPT_VERSION={bver!r}  ({len(bsys)} chars)")
    print(f"frontend PROMPT_VERSION={fver!r}  ({len(fsys)} chars)")
    if not bsys or not fsys:
        print("x could not extract one of the prompt strings (parser/format changed)")
        return 1
    if bver != fver:
        print(f"x PROMPT_VERSION mismatch: backend {bver!r} != frontend {fver!r}")
        ok = False
    if _norm(bsys) != _norm(fsys):
        nb, nf = _norm(bsys), _norm(fsys)
        i = next((k for k in range(min(len(nb), len(nf))) if nb[k] != nf[k]), min(len(nb), len(nf)))
        print("x SYSTEM prompt text differs after normalization.")
        print(f"  first divergence at normalized offset {i}")
        print(f"  backend : ...{nb[max(0,i-30):i+30]}...")
        print(f"  frontend: ...{nf[max(0,i-30):i+30]}...")
        ok = False
    print("OK — backend and frontend extraction prompts are in sync." if ok else "FAILED — prompts drifted.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
