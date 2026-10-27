// Unit tests for parseProjectTerms — the PURE normalizer for the projects.terms JSON column. It feeds the
// canonical-spelling glossary later injected into the cleanup step ("AiSensy", not "AI sensor"). No DB,
// no network — exercises the REAL shipped function from repo.ts.
import { describe, it, expect } from "vitest";
import { parseProjectTerms } from "../repo";

describe("parseProjectTerms", () => {
  it("parses a JSON string of {canonical, heardAs} objects", () => {
    const out = parseProjectTerms(JSON.stringify([
      { canonical: "AiSensy", heardAs: ["AI sensor", "AI Sensi"] },
      { canonical: "Nectar", heardAs: [] },
    ]));
    expect(out).toEqual([
      { canonical: "AiSensy", heardAs: ["AI sensor", "AI Sensi"] },
      { canonical: "Nectar", heardAs: [] },
    ]);
  });

  it("accepts an already-parsed array (not just a string)", () => {
    const out = parseProjectTerms([{ canonical: "Meta", heardAs: ["meta"] }]);
    // heardAs that only differs by case from canonical is dropped (it's not a distinct mis-hearing).
    expect(out).toEqual([{ canonical: "Meta", heardAs: [] }]);
  });

  it("coerces bare strings to {canonical, heardAs:[]}", () => {
    expect(parseProjectTerms(["Google Ads", "Instagram Graph API"])).toEqual([
      { canonical: "Google Ads", heardAs: [] },
      { canonical: "Instagram Graph API", heardAs: [] },
    ]);
  });

  it("trims, drops blanks, and dedupes canonicals case-insensitively (first wins)", () => {
    const out = parseProjectTerms([
      { canonical: "  AiSensy  ", heardAs: ["AI sensor"] },
      { canonical: "", heardAs: ["x"] },
      "   ",
      { canonical: "aisensy", heardAs: ["dup"] }, // case-insensitive duplicate of the first
    ]);
    expect(out).toEqual([{ canonical: "AiSensy", heardAs: ["AI sensor"] }]);
  });

  it("dedupes and trims heardAs entries", () => {
    const out = parseProjectTerms([{ canonical: "Salendra", heardAs: [" Selindra ", "Selindra", "", "Salindra"] }]);
    expect(out).toEqual([{ canonical: "Salendra", heardAs: ["Selindra", "Salindra"] }]);
  });

  it("is a clean no-op for empty/absent/garbage input", () => {
    expect(parseProjectTerms(null)).toEqual([]);
    expect(parseProjectTerms(undefined)).toEqual([]);
    expect(parseProjectTerms("")).toEqual([]);
    expect(parseProjectTerms("not json")).toEqual([]);
    expect(parseProjectTerms(42)).toEqual([]);
    expect(parseProjectTerms({})).toEqual([]);
  });
});
