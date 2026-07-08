# DEBUG TEARDOWN — remove before ship

Debug/diagnostic scaffolding added during the **Projects** feature build. Every entry here is a
**remove-before-ship** item. Do a full pass over this list before any production/store release and
delete or hard-disable each one.

---

## `debug_keep_audio` settings flag

- **What:** a boolean flag on the single `settings` JSON row, read via `repo.getSettings()`, **default `false`**.
- **Status in P0:** *declared only* — a **no-op placeholder**. Nothing reads it to change behavior yet.
  The actual keep-audio wiring (and its own teardown note) lands in a later phase.
- **Why it is dangerous:** **audio-is-never-persisted is a CORE PRIVACY PROMISE of Sutra.** Audio is used
  in-flight (transcription/voiceprint) and discarded; the only place the schema can hold raw audio is the
  opt-in, on-device-only `training_audio` table, and that is unwired. A "keep audio" debug flag exists
  purely for local diagnosis of capture bugs and must **NEVER ship enabled**.
- **Teardown checklist (when removing):**
  - [ ] Confirm `debug_keep_audio` is absent or `false` in every shipped/default settings path.
  - [ ] Remove any code that reads `debug_keep_audio` to retain audio.
  - [ ] Verify no audio bytes are written to disk/DB on the real device capture path.
  - [ ] Delete this section.

---

_Add new debug-scaffolding entries above this line as the feature grows._
