import { afterEach, describe, expect, it, vi } from "vitest";
import { isHostAuthorized, timingSafeEqual } from "../src/auth.ts";

const bytes = (...b: number[]) => new Uint8Array(b);

afterEach(() => vi.restoreAllMocks());

describe("isHostAuthorized", () => {
  // Generated per run: a fixed high-entropy literal here trips secret scanners for no benefit.
  const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

  it("accepts exactly the bearer secret", async () => {
    expect(await isHostAuthorized(`Bearer ${secret}`, secret)).toBe(true);
  });

  it("rejects a missing header, a missing secret, or any other value", async () => {
    expect(await isHostAuthorized(null, secret)).toBe(false);
    expect(await isHostAuthorized(`Bearer ${secret}`, undefined)).toBe(false);
    expect(await isHostAuthorized("Bearer ", "")).toBe(false);
    expect(await isHostAuthorized("Bearer wrong", secret)).toBe(false);
    expect(await isHostAuthorized(`Bearer ${secret.slice(0, -1)}`, secret)).toBe(false); // prefix
    expect(await isHostAuthorized(`Bearer ${secret}x`, secret)).toBe(false); // longer
    expect(await isHostAuthorized(`Bearer ${secret} `, secret)).toBe(false);
    expect(await isHostAuthorized(`bearer ${secret}`, secret)).toBe(false);
    expect(await isHostAuthorized(secret, secret)).toBe(false);
    expect(await isHostAuthorized(`Basic ${secret}`, secret)).toBe(false);
  });

  it("compares SHA-256 digests of both values, so lengths never short-circuit", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    expect(await isHostAuthorized("Bearer x", secret)).toBe(false);
    expect(digest).toHaveBeenCalledTimes(2);
    for (const [algo] of digest.mock.calls) expect(algo).toBe("SHA-256");
  });
});

describe("timingSafeEqual", () => {
  it("is true only for identical bytes", () => {
    expect(timingSafeEqual(bytes(1, 2, 3), bytes(1, 2, 3))).toBe(true);
    expect(timingSafeEqual(bytes(), bytes())).toBe(true);
    expect(timingSafeEqual(bytes(9, 2, 3), bytes(1, 2, 3))).toBe(false); // first byte
    expect(timingSafeEqual(bytes(1, 2, 9), bytes(1, 2, 3))).toBe(false); // last byte
    expect(timingSafeEqual(bytes(1, 2), bytes(1, 2, 3))).toBe(false);
    expect(timingSafeEqual(bytes(1, 2, 3, 0), bytes(1, 2, 3))).toBe(false); // trailing zero
  });

  it("reads every byte instead of stopping at the first difference", () => {
    const reads: number[] = [];
    const tracked = (n: number) => new Proxy(new Uint8Array(n), {
      get(t, k) { if (typeof k === "string" && /^\d+$/.test(k)) reads.push(Number(k)); const v = Reflect.get(t, k, t); return typeof v === "function" ? v.bind(t) : v; },
    });
    const a = tracked(32);
    const b = new Uint8Array(32).fill(1); // differs at index 0
    timingSafeEqual(a, b);
    expect(reads).toEqual(Array.from({ length: 32 }, (_, i) => i));
  });
});
