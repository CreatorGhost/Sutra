# Sutra eval harness (quality guardrail)

Runs gold conversations through the SAME provider + extraction prompt the app uses, and reports
metrics **OVERALL** and for the **Hinglish (`hi-en`) subset** separately.

## Quality bar (HARD RULE)
No model becomes a default unless, **on the `hi-en` subset specifically**:
- action-item **F1 >= 0.90 x** the cloud baseline, AND
- **CER <= 1.2 x** the cloud baseline.

## Gold sample schema
One JSON object per line in `gold/*.jsonl` (or one object per `gold/*.json`):
```json
{"id":"unique","lang":"hi-en",          // hi | en | hi-en  (drives the subset split)
 "audio":"/abs/path/clip.m4a",          // optional: enables WER/CER (ASR). null = extraction-only
 "transcript":[{"speaker":"Me","text":"..."}],   // reference turns (extraction input + ASR reference)
 "expected":{"entities":[{"name":"Ashoka University","type":"org"}],
             "action_items":[{"text":"...","owner":"Amartya"}],
             "decisions":["..."],"summary_points":["..."]}}
```
**To add audio (ASR) gold:** build it from your own recordings — transcribe with the cloud provider,
hand-correct the transcript, set `audio` to the clip path, keep `lang` accurate. Hand-corrected
transcripts are also gold labels for the future fine-tuning corpus.

## Run
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml exec backend \
  pip install -q -r evals/requirements.txt
docker compose -f docker-compose.yml -f docker-compose.dev.yml exec -w /app backend \
  python -m evals.run
```
Results (with `model_id` + `prompt_version` for corpus versioning) are written to `evals/results/`.
Re-run for every candidate model (cloud baseline first, then each on-device model later) and compare.
