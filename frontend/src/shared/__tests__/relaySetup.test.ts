import { describe, expect, it } from "vitest";
import {
  classifyProbeError, classifyProbeStatus, deviceLoginOpenUrl, generateHostSecret, nodeDist, parseDeployAccountId,
  parseDeviceLoginPrompt, parseWhoamiAccounts, parseWorkerUrl, parseWranglerAuthToken, redactSecrets, wranglerNeedsLogin,
} from "../pairing/relaySetup";
import { sanitizeRoutes } from "../pairing/protocol";

describe("relay setup parsing", () => {
  it("reads wrangler's device sign-in prompt and pre-fills the code", () => {
    const out = "\u001b[33mTo authorize Wrangler, please visit:\n\n  https://dash.cloudflare.com/oauth2/device\n\nand enter the code:\n\n  ABCD-EFGH\n";
    const p = parseDeviceLoginPrompt(out);
    expect(p).toEqual({ url: "https://dash.cloudflare.com/oauth2/device", code: "ABCD-EFGH" });
    expect(deviceLoginOpenUrl(p)).toBe("https://dash.cloudflare.com/oauth2/device?user_code=ABCD-EFGH");
    expect(parseDeviceLoginPrompt("please visit: https://evil.example.com/x").url).toBeNull();
  });

  it("finds the deployed address, accounts and token", () => {
    expect(parseWorkerUrl("Deployed sutra-relay triggers\n  https://sutra-relay.aditya.workers.dev\n", "sutra-relay")).toBe("https://sutra-relay.aditya.workers.dev");
    expect(parseWorkerUrl("https://other.aditya.workers.dev", "sutra-relay")).toBeNull();
    expect(parseWhoamiAccounts('warn\n{"accounts":[{"id":" a1 ","name":"Mine"},{"id":"a2"}]}')).toEqual([{ id: "a1", name: "Mine" }, { id: "a2", name: "a2" }]);
    expect(parseWhoamiAccounts("nope")).toBeNull();
    expect(parseWranglerAuthToken('{"type":"oauth","token":"tok-123"}')).toBe("tok-123");
    expect(parseWranglerAuthToken('{"type":"global_api_key","key":"x"}')).toBeNull();
    expect(parseDeployAccountId("https://dash.cloudflare.com/0123456789abcdef0123456789ABCDEF/workers/onboarding")).toBe("0123456789abcdef0123456789abcdef");
    expect(wranglerNeedsLogin("You are not authenticated.", 0)).toBe(true);
    expect(wranglerNeedsLogin("👋 You are logged in with an OAuth Token", 0)).toBe(false);
  });

  it("verifies the relay only on 426, and tells a blocked network from a rejected secret", () => {
    expect(classifyProbeStatus(426)).toEqual({ ok: true });
    expect(classifyProbeStatus(401)).toMatchObject({ ok: false, problem: "rejected" });
    expect(classifyProbeStatus(503)).toMatchObject({ ok: false, problem: "transient" });
    expect(classifyProbeError("ECONNRESET")).toMatchObject({ problem: "network" });
    expect(classifyProbeError("ENOTFOUND")).toMatchObject({ problem: "transient" });
  });

  it("pins an official Node download per platform, and redacts secrets", () => {
    expect(nodeDist("darwin", "arm64")).toMatchObject({ url: "https://nodejs.org/dist/v22.23.3/node-v22.23.3-darwin-arm64.tar.gz", zip: false });
    expect(nodeDist("win32", "x64")?.url).toMatch(/win-x64\.zip$/);
    expect(nodeDist("freebsd", "x64")).toBeNull();
    const secret = generateHostSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redactSecrets(`token ${secret} end`, [secret])).toBe("token [redacted] end");
  });

  it("keeps only well-formed routes from the Mac", () => {
    expect(sanitizeRoutes([
      { kind: "lan", url: "ws://192.168.1.5:47321" },
      { kind: "relay", url: "wss://sutra-relay.a.workers.dev/phone/abc" },
      { kind: "lan", url: "http://x" },
      { kind: "other", url: "ws://x" },
      null,
    ])).toEqual([{ kind: "lan", url: "ws://192.168.1.5:47321" }, { kind: "relay", url: "wss://sutra-relay.a.workers.dev/phone/abc" }]);
    expect(sanitizeRoutes("nope")).toEqual([]);
  });
});
