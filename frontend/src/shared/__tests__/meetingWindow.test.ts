import { describe, expect, it } from "vitest";
import { meetingWindow, type ScreenWindow } from "../meetingRules";

const w = (app: string, title: string, x = 0): ScreenWindow => ({ app, title, x, y: 0, width: 1200, height: 800 });

describe("meetingWindow", () => {
  it("finds the call's window so screenshots come from its screen", () => {
    expect(meetingWindow([w("Google Chrome", "Docs"), w("Google Chrome", "Meet - abc-defg-hij", 2000)], null)?.x).toBe(2000);
    expect(meetingWindow([w("Sutra", "Sutra 🔊"), w("Zoom", "", 3000)], { app: "Zoom" })?.x).toBe(3000);
    expect(meetingWindow([w("Google Chrome", "Docs"), w("Google Chrome", "Standup 🔊", 1500)], { app: "Google Chrome" })?.x).toBe(1500);
    expect(meetingWindow([w("ego lite", "meeting invite 7pm IST 🔊", -1000)], null)?.x).toBe(-1000);
    expect(meetingWindow([w("Finder", "Downloads")], null)).toBeNull();
  });
});
