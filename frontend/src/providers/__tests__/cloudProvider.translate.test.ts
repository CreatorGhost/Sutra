// Unit tests for the REAL CloudProvider.translate()/refine() ordinal-stripping + Devanagari retry/degrade
// (issue A: English transcript stage leaked injected "1. " ordinals and raw Hindi script). We exercise the
// shipped method and mock ONLY the network/JSON boundary (the private `json()` helper that POSTs /extract),
// so the numbered-prompt build, ordinal strip, retry, and raw fallback are all the real code under test.
import { describe, it, expect, vi } from "vitest";
import { CloudProvider } from "../cloudProvider";

// Stub the network/JSON layer. `replies` is consumed one per /extract call (translate may call twice:
// once for the batch, once for the Devanagari retry). Each reply is the parsed proxy body.
function mockJson(p: CloudProvider, replies: Array<{ translations?: string[]; lines?: string[] }>) {
  let n = 0;
  return vi.spyOn(p as any, "json").mockImplementation(async () => {
    const r = replies[Math.min(n, replies.length - 1)];
    n++;
    return r;
  });
}

describe("CloudProvider.translate — ordinal + Hindi defects (issue A)", () => {
  it("strips a leaked '1. '/'2. ' ordinal the model echoed back", async () => {
    const p = new CloudProvider("http://x");
    mockJson(p, [{ translations: ["1. Hello there", "2. How are you"] }]);
    const out = await p.translate(["namaste", "kaise ho"]);
    expect(out).toEqual(["Hello there", "How are you"]);
  });

  it("preserves a decimal/version — '1.5 million' is NOT stripped (no trailing space after the dot)", async () => {
    const p = new CloudProvider("http://x");
    mockJson(p, [{ translations: ["1.5 million dollars", "v2.0 release"] }]);
    const out = await p.translate(["a", "b"]);
    expect(out).toEqual(["1.5 million dollars", "v2.0 release"]);
  });

  it("holds the strict 1:1 array length", async () => {
    const p = new CloudProvider("http://x");
    mockJson(p, [{ translations: ["one", "two", "three"] }]);
    const out = await p.translate(["x", "y", "z"]);
    expect(out).toHaveLength(3);
  });

  it("falls back to the original when the model returns an empty line", async () => {
    const p = new CloudProvider("http://x");
    mockJson(p, [{ translations: ["", "real"] }]);
    const out = await p.translate(["raw-one", "raw-two"]);
    expect(out).toEqual(["raw-one", "real"]);
  });

  it("an ordinal-only line ('3. ') can never collapse to empty — falls back to the original", async () => {
    const p = new CloudProvider("http://x");
    mockJson(p, [{ translations: ["3. "] }]);
    const out = await p.translate(["kuch toh hai"]);
    expect(out).toEqual(["kuch toh hai"]);
  });

  it("retries a Devanagari line and accepts the clean Latin retry", async () => {
    const p = new CloudProvider("http://x");
    mockJson(p, [
      { translations: ["good", "मॉडर बनाना"] }, // line 2 leaks Devanagari
      { translations: ["making a moderator"] }, // batched retry returns clean Latin
    ]);
    const out = await p.translate(["a", "model banana"]);
    expect(out).toEqual(["good", "making a moderator"]);
    expect(out[1]).not.toMatch(/[ऀ-ॿ]/);
  });

  it("degrades to the original (never stores Devanagari) when the retry still leaks Hindi", async () => {
    const p = new CloudProvider("http://x");
    mockJson(p, [
      { translations: ["आधा अनुवाद"] }, // still Hindi
      { translations: ["फिर से हिंदी"] }, // retry STILL Hindi
    ]);
    const raw = "raw hindi line";
    const out = await p.translate([raw]);
    expect(out).toEqual([raw]);
    expect(out[0]).not.toMatch(/[ऀ-ॿ]/);
  });

  it("returns [] for empty input without calling the network", async () => {
    const p = new CloudProvider("http://x");
    const spy = mockJson(p, []);
    expect(await p.translate([])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("CloudProvider.transcribeDiarize — multichannel FormData threading (F6)", () => {
  // Spy the network boundary (fetchT) and capture the multipart body so we can inspect the fields.
  function spyTranscribe(p: CloudProvider) {
    return vi.spyOn(p as any, "fetchT").mockImplementation(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ text: "", duration: 0, segments: [] }),
    }));
  }
  const fdOf = (spy: any): FormData => spy.mock.calls[0][1].body as FormData;

  it("appends multichannel='true' ONLY when opts.multichannel is true", async () => {
    const p = new CloudProvider("http://x");
    const spy = spyTranscribe(p);
    await p.transcribeDiarize(new Blob([new Uint8Array(4)], { type: "audio/wav" }), "w.wav", { multichannel: true });
    expect(fdOf(spy).get("multichannel")).toBe("true");
  });

  it("sends NO multichannel field when omitted (ambient path unchanged)", async () => {
    const p = new CloudProvider("http://x");
    const spy = spyTranscribe(p);
    await p.transcribeDiarize(new Blob([new Uint8Array(4)], { type: "audio/webm" }), "w.webm", { prompt: "" });
    expect(fdOf(spy).has("multichannel")).toBe(false);
  });

  it("sends NO multichannel field when multichannel:false", async () => {
    const p = new CloudProvider("http://x");
    const spy = spyTranscribe(p);
    await p.transcribeDiarize(new Blob([new Uint8Array(4)]), "w.webm", { multichannel: false });
    expect(fdOf(spy).has("multichannel")).toBe(false);
  });
});

describe("CloudProvider.refine — same ordinal leak", () => {
  it("strips a leaked ordinal from refine() output", async () => {
    const p = new CloudProvider("http://x");
    mockJson(p, [{ lines: ["1. cleaned line", "2. another"] }]);
    const out = await p.refine(["a", "b"], { mode: "other" });
    expect(out).toEqual(["cleaned line", "another"]);
  });

  it("preserves a decimal in refine() and keeps 1:1 length / raw fallback", async () => {
    const p = new CloudProvider("http://x");
    mockJson(p, [{ lines: ["1.5x faster", ""] }]);
    const out = await p.refine(["raw-a", "raw-b"], { mode: "other" });
    expect(out).toEqual(["1.5x faster", "raw-b"]);
  });
});
