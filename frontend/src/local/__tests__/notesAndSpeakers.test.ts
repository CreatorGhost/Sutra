import { describe, it, expect } from "vitest";
import { coalesceTurns } from "../coalesce";
import { speakerName, isMe } from "../speakers";
import { notesToMarkdown, transcriptText } from "../notes";

describe("speakerName", () => {
  it("maps machine labels to people-friendly names", () => {
    expect(speakerName({ session_speaker_label: "me" })).toBe("Me");
    expect(speakerName({ session_speaker_label: "r0" })).toBe("Speaker 1");
    expect(speakerName({ session_speaker_label: "rB" })).toBe("Speaker B");
    expect(speakerName({ session_speaker_label: "2" })).toBe("Speaker 2");
    expect(speakerName({ session_speaker_label: "r0", person_name: "Priya" })).toBe("Priya");
    expect(isMe({ session_speaker_label: "me" })).toBe(true);
    expect(isMe({ session_speaker_label: "r1" })).toBe(false);
  });
});

describe("coalesceTurns", () => {
  const t = (id: number, label: string, text: string, start: number, end: number, win = 0) =>
    ({ id, session_speaker_label: label, person_id: null, text, start_ts: start, end_ts: end, window_index: win });
  it("merges consecutive same-speaker fragments within the gap", () => {
    const out = coalesceTurns([t(1, "A", "Hello", 0, 1), t(2, "A", "there", 1.5, 2), t(3, "B", "Hi", 2.2, 3), t(4, "B", "later", 10, 11)]);
    expect(out.map((x) => x.text)).toEqual(["Hello there", "Hi", "later"]);
    expect(out[0].turn_ids).toEqual([1, 2]);
  });
  it("does not merge across windows unless asked", () => {
    const rows = [t(1, "A", "one", 0, 1, 0), t(2, "A", "two", 0, 1, 1)];
    expect(coalesceTurns(rows)).toHaveLength(2);
    expect(coalesceTurns(rows, { crossWindow: true })).toHaveLength(1);
  });
  it("drops empty fragments", () => {
    expect(coalesceTurns([t(1, "A", "  ", 0, 1)])).toHaveLength(0);
  });
});

describe("notes markdown", () => {
  const detail: any = {
    conversation: { title: "x", started_at: "2026-09-22 10:00:00", source_app: "Google Chrome" },
    memory: { title: "Monitoring and demo access", subtitle: "Team synced on monitoring.", summary: "We discussed monitoring.",
              decisions: [], open_questions: ["Why did findings disappear?"] },
    actions: [{ id: 1, text: "Test monitoring locally", owner: "Aditya", status: "open" }, { id: 2, text: "Move ticket", owner: null, status: "done" }],
    turns: [{ session_speaker_label: "me", text: "hello" }],
  };
  it("renders the Brief style like the app shows it", () => {
    const md = notesToMarkdown(detail, "brief");
    expect(md).toContain("# Monitoring and demo access");
    expect(md).toContain("## Decisions\n\n- none");
    expect(md).toContain("- [ ] **Aditya:** Test monitoring locally");
    expect(md).toContain("- [x] Move ticket");
    expect(md).toContain("## Open questions\n\n- Why did findings disappear?");
    expect(md).not.toContain("## Transcript");
  });
  it("renders Detailed topics and optionally the transcript", () => {
    const md = notesToMarkdown(detail, "detailed", {
      overview: "Overview.", topics: [{ heading: "Monitoring", points: ["Alerts done"] }], decisions: ["Ship"],
      action_items: [], open_questions: [], next_steps: ["Deploy"],
    }, true);
    expect(md).toContain("## Monitoring\n\n- Alerts done");
    expect(md).toContain("## Next steps");
    expect(md).toContain("**Me:** hello");
  });
  it("caps very long transcripts but keeps both ends", () => {
    const turns = Array.from({ length: 5000 }, (_, i) => ({ session_speaker_label: "r0", text: `line ${i}` }));
    const text = transcriptText(turns, 2000);
    expect(text.length).toBeLessThan(2200);
    expect(text).toContain("line 0");
    expect(text).toContain("line 4999");
  });
});
