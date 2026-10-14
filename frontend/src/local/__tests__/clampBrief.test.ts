// Unit tests for clampBrief + BRIEF_CAP — the PURE brief-size cap shared by the Project detail UI (live
// counter + on-blur trim) and the later injection step, per the "lost in the middle" / context-budget
// research. No DB, no network — exercises the REAL shipped function from repo.ts.
import { describe, it, expect } from "vitest";
import { clampBrief, BRIEF_CAP } from "../repo";

describe("clampBrief", () => {
  it("uses a 1500-char default cap", () => {
    expect(BRIEF_CAP).toBe(1500);
  });

  it("leaves a brief at or under the cap untouched", () => {
    const s = "Nectar — AiSensy + Meta + Google Ads. Salendra owns backend (FastAPI, GCP).";
    expect(clampBrief(s)).toBe(s);
    const exact = "x".repeat(BRIEF_CAP);
    expect(clampBrief(exact)).toBe(exact);
    expect(clampBrief(exact).length).toBe(BRIEF_CAP);
  });

  it("truncates a brief longer than the cap to exactly the cap length", () => {
    const long = "y".repeat(BRIEF_CAP + 500);
    const out = clampBrief(long);
    expect(out.length).toBe(BRIEF_CAP);
    expect(out).toBe("y".repeat(BRIEF_CAP));
  });

  it("honors an explicit smaller cap", () => {
    expect(clampBrief("abcdef", 3)).toBe("abc");
  });

  it("is a clean no-op for null/undefined (-> empty string)", () => {
    expect(clampBrief(null)).toBe("");
    expect(clampBrief(undefined)).toBe("");
    expect(clampBrief("")).toBe("");
  });

  it("coerces non-strings rather than throwing", () => {
    expect(clampBrief(42)).toBe("42");
  });
});
