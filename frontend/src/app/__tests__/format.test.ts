import { describe, it, expect } from "vitest";
import { clock, duration, groupByPeriod, periodLabel } from "../format";

describe("format", () => {
  const now = new Date(2026, 8, 26, 12, 0, 0); // Sat Sep 26 2026 (local)
  it("labels sidebar periods", () => {
    expect(periodLabel(new Date(2026, 8, 26, 9).toISOString(), now)).toBe("Today");
    expect(periodLabel(new Date(2026, 8, 22, 9).toISOString(), now)).toBe("This week");
    expect(periodLabel(new Date(2026, 8, 17, 9).toISOString(), now)).toBe("This month");
    expect(periodLabel(new Date(2026, 7, 3, 9).toISOString(), now)).toMatch(/2026/);
  });
  it("groups in order", () => {
    const items = [new Date(2026, 8, 26), new Date(2026, 8, 22), new Date(2026, 8, 21), new Date(2026, 8, 17)].map((d) => d.toISOString());
    expect(groupByPeriod(items, (x) => x, now).map((g) => [g.label, g.items.length])).toEqual([["Today", 1], ["This week", 2], ["This month", 1]]);
  });
  it("formats clocks and durations", () => {
    expect(clock(65000)).toBe("1:05");
    expect(clock(3723000)).toBe("1:02:03");
    expect(duration("2026-09-22 10:00:00", "2026-09-22 10:42:00")).toBe("42 min");
    expect(duration("2026-09-22 10:00:00", "2026-09-22 11:05:00")).toBe("1 h 5 min");
  });
});
