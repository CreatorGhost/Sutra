// "Where does the thinking happen?" — local speech models + the AI engine for notes/questions.
// Shown in Settings and as the first-run setup on Home (desktop). The two halves live in their own
// components (SpeechSettings / EngineSettings).
import { EngineSettings } from "./EngineSettings";
import { SpeechSettings } from "./SpeechSettings";

export { localSttReady } from "./SpeechSettings";

export function Intelligence({ settings, onChange }: { settings: Record<string, unknown>; onChange: (patch: Record<string, unknown>) => Promise<void> }) {
  return (
    <>
      <SpeechSettings settings={settings} onChange={onChange} />
      <div style={{ height: 22 }} />
      <EngineSettings settings={settings} onChange={onChange} />
    </>
  );
}
