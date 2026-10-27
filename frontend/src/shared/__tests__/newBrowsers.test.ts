import { describe, expect, it } from "vitest";
import { appName, detectMeeting, macAppCandidates } from "../meetingRules";

describe("newer browsers", () => {
  it("names Comet, Helium and ego lite from their bundles and finds their icons", () => {
    expect(appName("/Applications/Comet.app/Contents/MacOS/Comet")).toBe("Comet");
    expect(appName("/Applications/Helium.app/Contents/Frameworks/Helium Helper.app/Contents/MacOS/Helium Helper")).toBe("Helium");
    expect(macAppCandidates("ego lite")[0]).toBe("/Applications/ego lite.app");
  });
  it("treats a Meet tab holding the mic in Comet as a call", () => {
    const d = detectMeeting({
      micConsumers: [{ path: "/Applications/Comet.app/Contents/MacOS/Comet" }],
      tabs: [{ browser: "Comet", url: "https://meet.google.com/abc-defg-hij" }],
    });
    expect(d).toMatchObject({ app: "Comet", service: "Google Meet", source: "mic" });
  });
});
