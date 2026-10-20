import { describe, it, expect } from "vitest";
import { cleanItems } from "../appleApps";

describe("items for Reminders / Calendar", () => {
  it("bounds text, keeps real dates, and needs a date for Calendar", () => {
    const r = cleanItems("reminders", [{ title: "  Send   the deck ", notes: "x".repeat(5000), at: "nope" }, { title: "" }]);
    expect(r.items).toEqual([{ title: "Send the deck", notes: "x".repeat(2000), at: null }]);
    expect(() => cleanItems("calendar", [{ title: "Sync" }])).toThrow(/date/);
    expect(cleanItems("calendar", [{ title: "Sync", at: "2026-10-21T10:00:00Z" }]).items[0].at).toBe("2026-10-21T10:00:00.000Z");
    expect(() => cleanItems("shell", [{ title: "x" }])).toThrow();
    expect(() => cleanItems("reminders", Array(51).fill({ title: "x" }))).toThrow();
  });
});
