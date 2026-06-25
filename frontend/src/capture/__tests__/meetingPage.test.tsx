// Meeting page render test (ticket F2). Renders the REAL page via react-dom/server (no jsdom needed)
// to prove it resolves a provider through createCaptureProvider(capability) and renders without
// crashing in BOTH an unsupported context (no DOM globals → Safari/jsdom-like) and a supported one
// (mocked Chromium getDisplayMedia) — i.e. no regression to the F1 capability gate.
import { describe, it, expect, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import Meeting from "../../pages/Meeting";

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

afterEach(() => {
  delete (globalThis as any).navigator;
});

/** Set a (possibly getter-only, e.g. Node's built-in navigator) global by force. */
function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

describe("Meeting page", () => {
  it("renders the unsupported fallback (no DOM globals) without crashing", () => {
    const html = renderToStaticMarkup(createElement(Meeting));
    expect(html).toContain("Meeting capture needs the desktop app or Chrome/Edge");
    // The gate fallback ALSO carries the canonical audio-never-stored copy (ticket F7).
    expect(html).toContain("Audio is processed live and never stored.");
  });

  it("renders the REAL capture UI (not the old stub) in a mocked Chromium context", () => {
    setGlobal("navigator", {
      userAgent: CHROME_UA,
      mediaDevices: { getDisplayMedia: () => {}, getUserMedia: () => {} },
    });
    const html = renderToStaticMarkup(createElement(Meeting));
    expect(html).toContain("Meeting capture");
    // Provider was resolved and its kind rendered (browser path here).
    expect(html).toContain("browser");
    // The real capture surface — NOT the old "lands next" stub.
    expect(html).not.toContain("Two-channel capture lands next");
    // A Start control + a live-status region + source/mic indicators.
    expect(html).toContain("Start");
    expect(html).toContain("status-line");
    expect(html).toContain("system → remotes");
    expect(html).toContain("mic → me");
    // The privacy line is always present here too.
    expect(html).toContain("never stored");
  });
});
