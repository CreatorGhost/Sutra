import { describe, it, expect } from "vitest";
import { gateEcho, rms } from "../channels";

const SR = 16000;
const tone = (n: number, f: number, a: number, phase = 0) => Array.from({ length: n }, (_, i) => a * Math.sin(2 * Math.PI * f * (i + phase) / SR));
const pcm = (xs: number[]) => Int16Array.from(xs, (x) => Math.round(Math.max(-1, Math.min(1, x)) * 32767));

describe("echo gate on your mic", () => {
  // 0–4 s: someone talks on the call, you're silent (the mic only hears it through the speakers, at 30%, 10 ms late)
  // 4–6 s: the call is quiet and you talk
  // 6–8 s: you talk over someone
  const call = [...tone(4 * SR, 220, 0.3), ...Array(2 * SR).fill(0), ...tone(2 * SR, 220, 0.3)];
  const you = [...Array(4 * SR).fill(0), ...tone(2 * SR, 330, 0.25), ...tone(2 * SR, 330, 0.4)];
  const mic = call.map((_, i) => 0.3 * (call[i - 160] ?? 0) + you[i]);

  it("silences the echo and keeps your own voice", () => {
    const out = gateEcho(pcm(mic), pcm(call), SR);
    expect(rms(out, 0.2 * SR, 3.8 * SR)).toBeLessThan(0.005); // the echo is gone
    expect(rms(out, 4.2 * SR, 5.8 * SR)).toBeGreaterThan(0.1);  // you alone: kept
    expect(rms(out, 6.2 * SR, 7.8 * SR)).toBeGreaterThan(0.1);  // you over the call: kept
  });

  it("leaves the mic alone with headphones (the call doesn't reach it)", () => {
    const quiet = call.map((_, i) => 0.01 * call[i] + you[i]);
    const m = pcm(quiet);
    expect(gateEcho(m, pcm(call), SR)).toEqual(m);
  });
});
