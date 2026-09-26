import { describe, it, expect } from "vitest";
import {
  DetectionTracker,
  appName,
  bundlePath,
  detectMeeting,
  parsePactlSourceOutputs,
  parseUrlList,
  parseWindowsMicRegistry,
  serviceForUrl,
} from "../meetingRules";

describe("appName", () => {
  it("names macOS bundles, Windows exes, registry leaves and store packages", () => {
    expect(appName("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")).toBe("Google Chrome");
    expect(appName("/Applications/zoom.us.app/Contents/MacOS/zoom.us")).toBe("Zoom");
    expect(appName("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")).toBe("Google Chrome");
    expect(appName("C:#Program Files (x86)#Microsoft#Edge#Application#msedge.exe")).toBe("Microsoft Edge");
    expect(appName("MSTeams_8wekyb3d8bbwe")).toBe("Microsoft Teams");
    expect(appName("SomethingElse.exe")).toBe("SomethingElse");
  });
  it("finds the bundle path for an executable", () => {
    expect(bundlePath("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")).toBe("/Applications/Google Chrome.app");
    expect(bundlePath("C:\\x\\chrome.exe")).toBeNull();
  });
});

describe("serviceForUrl", () => {
  it("recognises real meeting rooms, not landing pages", () => {
    expect(serviceForUrl("https://meet.google.com/abc-defg-hij")).toBe("Google Meet");
    expect(serviceForUrl("https://meet.google.com/abc-defg-hij?authuser=1")).toBe("Google Meet");
    expect(serviceForUrl("https://meet.google.com/landing")).toBeNull();
    expect(serviceForUrl("https://us02web.zoom.us/wc/123456/join")).toBe("Zoom");
    expect(serviceForUrl("https://zoom.us/pricing")).toBeNull();
    expect(serviceForUrl("https://teams.microsoft.com/l/meetup-join/19%3ameeting")).toBe("Microsoft Teams");
    expect(serviceForUrl("https://app.slack.com/huddle/T1/C2")).toBe("Slack Huddle");
    expect(serviceForUrl("https://github.com/")).toBeNull();
  });
});

describe("detectMeeting", () => {
  it("mic consumer wins and a matching tab supplies the service", () => {
    const d = detectMeeting({
      micConsumers: [{ name: "Google Chrome", path: "C:\\Chrome\\chrome.exe" }],
      tabs: [{ browser: "Google Chrome", url: "https://meet.google.com/abc-defg-hij" }],
    });
    expect(d).toMatchObject({ app: "Google Chrome", service: "Google Meet", source: "mic" });
  });
  it("ignores our own app and non-call mic users", () => {
    expect(detectMeeting({ micConsumers: [{ name: "Sutra" }, { name: "Voice Memos" }, { name: "Audacity" }] })).toBeNull();
  });
  it("falls back to a meeting tab (macOS has no mic-consumer API)", () => {
    expect(detectMeeting({ tabs: [{ browser: "Arc", url: "https://meet.google.com/xyz-abcd-efg" }] }))
      .toMatchObject({ app: "Arc", service: "Google Meet", source: "tab" });
  });
  it("detects a Zoom meeting from CptHost", () => {
    expect(detectMeeting({ processes: ["/Applications/zoom.us.app/Contents/Frameworks/cpthost.app/Contents/MacOS/CptHost"] }))
      .toMatchObject({ app: "Zoom", source: "process" });
  });
  it("detects from window titles", () => {
    expect(detectMeeting({ windows: [{ title: "Zoom Meeting" }] })).toMatchObject({ app: "Zoom" });
    expect(detectMeeting({ windows: [{ title: "Meet - abc-defg-hij", app: "Google Chrome" }] }))
      .toMatchObject({ app: "Google Chrome", service: "Google Meet" });
    expect(detectMeeting({ windows: [{ title: "Weekly sync | Microsoft Teams" }] })).toBeNull();
    expect(detectMeeting({ windows: [{ title: "Meeting with Priya | Microsoft Teams" }] })).toMatchObject({ app: "Microsoft Teams" });
  });
  it("returns null when nothing matches", () => {
    expect(detectMeeting({ tabs: [{ browser: "Safari", url: "https://news.ycombinator.com" }], windows: [{ title: "Inbox" }] })).toBeNull();
  });
});

describe("DetectionTracker", () => {
  const meet = { app: "Google Chrome", service: "Google Meet", source: "tab" as const, key: "Google Chrome|Google Meet" };

  it("raises only after consecutive hits and clears after consecutive misses", () => {
    const t = new DetectionTracker(2, 3);
    expect(t.update(meet).active).toBeNull();
    const up = t.update(meet);
    expect(up.active?.app).toBe("Google Chrome");
    expect(up.changed).toBe(true);
    expect(t.update(null).active).not.toBeNull(); // one miss is not enough
    t.update(null);
    const end = t.update(null);
    expect(end.active).toBeNull();
    expect(end.ended?.key).toBe(meet.key);
  });

  it("a single flicker never raises", () => {
    const t = new DetectionTracker(2, 3);
    t.update(meet);
    t.update(null);
    expect(t.update(meet).active).toBeNull();
  });

  it("dismiss hides this call only and re-arms after it ends", () => {
    const t = new DetectionTracker(1, 1);
    t.update(meet);
    expect(t.visible).toBe(true);
    t.dismiss();
    expect(t.update(meet).visible).toBe(false);
    t.update(null); // call ended
    expect(t.update(meet).visible).toBe(true);
  });
});

describe("platform parsers", () => {
  it("parses the Windows microphone consent store", () => {
    const text = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged",
      "",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Program Files#Google#Chrome#Application#chrome.exe",
      "    LastUsedTimeStart    REG_QWORD    0x1db0f1e2c3a4b5c",
      "    LastUsedTimeStop    REG_QWORD    0x0",
      "",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Tools#recorder.exe",
      "    LastUsedTimeStart    REG_QWORD    0x1db0f1e2c3a4b5c",
      "    LastUsedTimeStop    REG_QWORD    0x1db0f1e2c3a4b9f",
      "",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\MSTeams_8wekyb3d8bbwe",
      "    Value    REG_SZ    Allow",
      "    LastUsedTimeStart    REG_QWORD    0x1db0f1e2c3a4b5c",
      "    LastUsedTimeStop    REG_QWORD    0x0",
    ].join("\r\n");
    const got = parseWindowsMicRegistry(text);
    expect(got.map((c) => c.name)).toEqual(["Google Chrome", "Microsoft Teams"]);
    expect(got[0].path).toBe("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  });

  it("parses pactl source outputs and skips meters / corked streams", () => {
    const text = [
      "Source Output #12",
      "\tCorked: no",
      "\tProperties:",
      '\t\tapplication.name = "Google Chrome"',
      '\t\tapplication.process.binary = "chrome"',
      "",
      "Source Output #13",
      "\tCorked: no",
      "\tProperties:",
      '\t\tapplication.name = "PulseAudio Volume Control"',
      '\t\tapplication.id = "org.PulseAudio.pavucontrol"',
      "",
      "Source Output #14",
      "\tCorked: yes",
      "\tProperties:",
      '\t\tapplication.name = "Zoom"',
    ].join("\n");
    expect(parsePactlSourceOutputs(text).map((c) => c.name)).toEqual(["Google Chrome"]);
  });

  it("pulls URLs out of osascript list output", () => {
    expect(parseUrlList("https://meet.google.com/abc-defg-hij, https://github.com/x, missing value"))
      .toEqual(["https://meet.google.com/abc-defg-hij", "https://github.com/x"]);
  });
});
