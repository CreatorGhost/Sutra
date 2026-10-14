import { describe, it, expect, vi } from "vitest";
import {
  AutoStop, DetectionTracker,
  appFromBundleId,
  appName,
  bundlePath,
  macAppCandidates,
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

describe("macOS mic consumers (micwatch helper)", () => {
  it("maps helper processes and bundle ids to the real app", () => {
    expect(appFromBundleId("com.google.Chrome.helper")).toBe("Google Chrome");
    expect(appFromBundleId("net.whatsapp.WhatsApp")).toBe("WhatsApp");
    expect(appFromBundleId("com.example.nope")).toBeNull();
    expect(detectMeeting({ micConsumers: [{ name: "net.whatsapp.WhatsApp", path: "/Applications/WhatsApp.app/Contents/MacOS/WhatsApp" }] }))
      .toMatchObject({ app: "WhatsApp", service: "WhatsApp", source: "mic" });
    expect(detectMeeting({ micConsumers: [{ name: "com.google.Chrome.helper", path: "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper" }] }))
      .toMatchObject({ app: "Google Chrome", source: "mic" });
    expect(detectMeeting({ micConsumers: [{ name: "com.apple.FaceTime" }] })).toMatchObject({ app: "FaceTime" });
  });
  it("never treats Sutra's own recording as a call", () => {
    expect(detectMeeting({ micConsumers: [{ name: "app.sutra.desktop", path: "/Applications/Sutra.app/Contents/Frameworks/Sutra Helper.app/Contents/MacOS/Sutra Helper" }] })).toBeNull();
    expect(detectMeeting({ micConsumers: [{ path: "/Users/me/Sutra/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper" }] })).toBeNull();
  });
  it("knows where apps live for their icons", () => {
    expect(macAppCandidates("Zoom")[0]).toBe("/Applications/zoom.us.app");
    expect(macAppCandidates("FaceTime")).toContain("/System/Applications/FaceTime.app");
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

  it("the same call seen through another signal is not a new call (no mid-meeting auto-stop)", () => {
    const t = new DetectionTracker(2, 3);
    t.update(meet);
    t.update(meet);
    // A window title names it "Browser|Google Meet"; the mic alone, before the tab matches, "Google Chrome|".
    const viaTitle = { app: "Browser", service: "Google Meet", source: "window" as const, key: "Browser|Google Meet" };
    const viaMic = { app: "Google Chrome", source: "mic" as const, key: "Google Chrome|" };
    for (const d of [viaTitle, viaTitle, viaTitle, viaMic, viaMic, viaMic]) {
      const up = t.update(d);
      expect(up.ended).toBeUndefined();
      expect(up.active).toMatchObject({ key: meet.key, app: "Google Chrome", service: "Google Meet" });
    }
    // Hanging up still ends it — under the key the recording was started with.
    t.update(null); t.update(null);
    expect(t.update(null).ended?.key).toBe(meet.key);
  });

  it("a different meeting service on the same app is a new call", () => {
    const t = new DetectionTracker(1, 3);
    t.update(meet);
    const zoomWeb = { app: "Google Chrome", service: "Zoom", source: "tab" as const, key: "Google Chrome|Zoom" };
    expect(t.update(zoomWeb).ended?.key).toBe(meet.key);
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

describe("AutoStop (stop when the call ends, with a grace period)", () => {
  const meet = { app: "Google Chrome", service: "Google Meet", source: "tab" as const, key: "Google Chrome|Google Meet" };
  const viaTitle = { app: "Browser", service: "Google Meet", source: "window" as const, key: "Browser|Google Meet" };
  function harness() {
    let pending: (() => void) | null = null;
    const stop = vi.fn();
    const a = new AutoStop(stop, 45_000, { set: (fn) => { pending = fn; return 1; }, clear: () => { pending = null; } });
    return { a, stop, fire: () => { const f = pending; pending = null; f?.(); }, get pending() { return pending; } };
  }

  it("a call that vanishes and comes back (switching Chrome tabs) never stops the recording", () => {
    const h = harness();
    h.a.recording(meet);
    h.a.update({ active: null, ended: meet }, true); // gone: grace period starts
    expect(h.pending).not.toBeNull();
    h.a.update({ active: viaTitle }, true);           // back, under another name
    expect(h.pending).toBeNull();
    h.fire();
    expect(h.stop).not.toHaveBeenCalled();
  });

  it("stops once the call stays gone, and only when the setting is on", () => {
    const h = harness();
    h.a.recording(meet);
    h.a.update({ active: null, ended: viaTitle }, true);
    h.fire();
    expect(h.stop).toHaveBeenCalledTimes(1);
    const off = harness();
    off.a.recording(meet);
    off.a.update({ active: null, ended: meet }, false);
    expect(off.pending).toBeNull();
  });

  it("a recording not started for a detected call, or already stopped, is left alone", () => {
    const h = harness();
    h.a.recording(null);
    h.a.update({ active: null, ended: meet }, true);
    expect(h.pending).toBeNull();
    h.a.recording(meet);
    h.a.update({ active: null, ended: meet }, true);
    h.a.idle();
    h.fire();
    expect(h.stop).not.toHaveBeenCalled();
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
