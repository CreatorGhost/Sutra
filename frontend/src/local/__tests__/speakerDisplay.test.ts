// Unit tests for buildSpeakerDisplay — the PURE display-only mapping that keeps raw voiceprint-cluster
// ids ("c1") out of the transcript UI and generated minutes (issue B). No DB, no network.
import { describe, it, expect } from "vitest";
import { buildSpeakerDisplay } from "../util";

describe("buildSpeakerDisplay", () => {
  it("maps raw cluster labels to 1-indexed Speaker N in first-appearance order", () => {
    const turns = [
      { session_speaker_label: "c2" },
      { session_speaker_label: "c1" },
      { session_speaker_label: "c2" },
      { session_speaker_label: "c3" },
    ];
    const m = buildSpeakerDisplay(turns);
    // c2 appears first -> Speaker 1; never leaks the raw "c" id.
    expect(m.get("c2")).toBe("Speaker 1");
    expect(m.get("c1")).toBe("Speaker 2");
    expect(m.get("c3")).toBe("Speaker 3");
    for (const v of m.values()) expect(v).not.toMatch(/c\d/);
  });

  it("is stable: repeated labels reuse the same Speaker N and the count is distinct labels", () => {
    const turns = [{ session_speaker_label: "c1" }, { session_speaker_label: "c1" }, { session_speaker_label: "c1" }];
    const m = buildSpeakerDisplay(turns);
    expect(m.size).toBe(1);
    expect(m.get("c1")).toBe("Speaker 1");
  });

  it("skips null/empty labels without consuming a number", () => {
    const turns = [
      { session_speaker_label: null },
      { session_speaker_label: "" },
      { session_speaker_label: "c1" },
    ];
    const m = buildSpeakerDisplay(turns as any);
    expect(m.get("c1")).toBe("Speaker 1"); // still Speaker 1, not Speaker 3
    expect(m.size).toBe(1);
  });

  it("supports inverting display -> raw so a model's returned label maps back to cN", () => {
    const m = buildSpeakerDisplay([{ session_speaker_label: "c1" }, { session_speaker_label: "c2" }]);
    const rawByDisplay = new Map<string, string>();
    for (const [raw, disp] of m) {
      rawByDisplay.set(disp.toLowerCase(), raw);
      rawByDisplay.set(disp.replace(/^speaker\s+/i, "").trim(), raw);
    }
    // Model can return either "Speaker 2" or the bare "2"; both resolve to the raw key "c2".
    expect(rawByDisplay.get("speaker 2")).toBe("c2");
    expect(rawByDisplay.get("2")).toBe("c2");
  });
});
