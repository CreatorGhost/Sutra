import { describe, it, expect } from "vitest";
import { micBleedIds } from "../channelAttribution";

const at = (s: number) => new Date(Date.UTC(2026, 9, 19, 10, 0, s)).toISOString();
const t = (id: number, label: string, sec: number, text: string) => ({ id, session_speaker_label: label, text, abs_start: at(sec), start_ts: 0, end_ts: 5 });

describe("mic bleed", () => {
  it("drops the mic's copy of a remote line, keeps what the owner actually said", () => {
    const ids = micBleedIds([
      t(1, "r0", 5, "So first of all, when we had those tickets, I had a discussion with Moe about the back-end change."),
      t(2, "me", 5, "So first of all like when we had those tickets. So I had discussion with um Mody about the back end change."),
      t(3, "me", 30, "I worked on two tickets; one hit a merge conflict and the other is now with Lakshya."),
      t(4, "c1", 31, "Okay, thanks."),
      t(5, "me", 120, "Okay, thanks."),            // nobody else spoke then
      // talking over someone: same moment, shared filler and one topic word — not a copy
      t(6, "r0", 200, "The deployment pipeline failed again because staging credentials expired yesterday."),
      t(7, "me", 201, "Yes the pipeline, I can rotate those credentials after this call."),
    ]);
    expect(ids).toEqual([2]);
  });
});
