import { describe, expect, it } from "vitest";
import { meetingEmoji, meetingHue } from "../meetingTile";

describe("meeting tile", () => {
  it("picks the emoji from what the meeting was about", () => {
    expect(meetingEmoji({ title: "Sprint planning with Farha" })).toBe("🗺️");
    expect(meetingEmoji({ title: "Coffee catchup" })).toBe("☕");
    expect(meetingEmoji({ title: "Weekly sync", summary: "Q3 budget and revenue forecast" })).toBe("📊");
    expect(meetingEmoji({ title: "Call", tags: ["interview"] })).toBe("🧑‍💼");
  });
  it("the more specific topic wins", () => {
    // An incident review about a release is about the incident.
    expect(meetingEmoji({ title: "Release incident post-mortem" })).toBe("🐞");
  });
  it("falls back to a speech bubble, and flags notes that failed", () => {
    expect(meetingEmoji({ title: "Untitled" })).toBe("💬");
    expect(meetingEmoji({ title: null, status: "failed" })).toBe("⚠️");
  });
  it("tints by project colour, else a stable colour per meeting", () => {
    expect(meetingHue({ id: 3 }, "#ff0000")).toBe("#ff0000");
    expect(meetingHue({ id: 3 })).toBe("var(--text-3)");
  });
});
