import asyncio, json, pathlib
from app.providers import get_provider
from app.schemas import EXTRACTION_JSON_SCHEMA
from app.services.extraction import SYSTEM
gold = [json.loads(l) for l in open("evals/gold/seed.jsonl") if l.strip()]
async def main():
    p = get_provider()
    for s in gold:
        t = "\n".join(f"{x['speaker']}: {x['text']}" for x in s["transcript"])
        d = await p.extract(EXTRACTION_JSON_SCHEMA, SYSTEM, t)
        pred = [f"{e['name']}/{e['type']}" for e in d.get("entities", [])]
        goldn = [f"{e['name']}/{e['type']}" for e in s["expected"]["entities"]]
        print(f"\n## {s['id']} ({s['lang']})  gold={len(goldn)} pred={len(pred)}")
        print("  GOLD:", goldn)
        print("  PRED:", pred)
asyncio.run(main())
