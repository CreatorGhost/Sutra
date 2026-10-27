import { describe, it, expect } from "vitest";
import { SPEAKER_PACK, findSpeechModel } from "../speechModels";

describe("speech model downloads are pinned", () => {
  it("the speaker pack and the default model carry a SHA-256", () => {
    for (const a of [...SPEAKER_PACK.assets, ...findSpeechModel("qwen3-asr-0.6b")!.assets]) expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
