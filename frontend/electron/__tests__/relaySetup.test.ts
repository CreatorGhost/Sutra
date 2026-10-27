import { describe, expect, it, vi } from "vitest";
import { RelaySetup, type RelaySetupDeps } from "../pairing/relaySetup";
import type { RunOptions, RunResult, WranglerSession } from "../pairing/wrangler";
import type { DeployedRelay, ProbeOutcome, RelaySetupState } from "../../src/shared/pairing/relaySetup";

const URL_OUT = "Uploaded sutra-relay\nDeployed sutra-relay triggers\n  https://sutra-relay.aditya.workers.dev\n";

/** A fake wrangler: each command answers from `script` (by its first words). */
function harness(script: Record<string, RunResult | ((o: RunOptions) => RunResult)>, over: Partial<RelaySetupDeps> = {}) {
  const calls: { args: string[]; o: RunOptions }[] = [];
  const states: RelaySetupState[] = [];
  let relay = { url: "", hostSecret: null as string | null, enabled: false };
  let deployed: DeployedRelay | null = null;
  const session: WranglerSession = {
    configPath: "/tmp/stage/wrangler.json",
    dispose: async () => {},
    run: async (args, o = {}) => {
      calls.push({ args, o });
      const key = Object.keys(script).filter((k) => args.join(" ").startsWith(k)).sort((a, b) => b.length - a.length)[0];
      const r = key ? script[key]! : { code: 0, output: "" };
      return typeof r === "function" ? r(o) : r;
    },
  };
  const deps: RelaySetupDeps = {
    prepare: async () => session,
    probe: vi.fn(async (): Promise<ProbeOutcome> => ({ ok: true })),
    cfApi: vi.fn(async () => ({ status: 200, json: { success: true, result: {} } })),
    relay: () => relay,
    saveRelay: (p) => { relay = { url: p.url ?? relay.url, hostSecret: p.hostSecret === undefined ? relay.hostSecret : p.hostSecret || null, enabled: p.enabled ?? relay.enabled }; },
    readDeployed: () => deployed,
    writeDeployed: (d) => { deployed = d; },
    openExternal: vi.fn(),
    onState: (s) => states.push(s),
    sleep: async () => {},
    random: () => 0.1,
    ...over,
  };
  const setup = new RelaySetup(deps);
  const settled = () => vi.waitFor(() => expect(setup.running).toBe(false));
  return { setup, deps, calls, states, settled, get relay() { return relay; }, get deployed() { return deployed; } };
}

describe("one-click relay setup", () => {
  it("signs in, deploys, stores the secret over stdin only, verifies, and saves", async () => {
    const h = harness({
      "whoami --json": { code: 0, output: '{"accounts":[{"id":"acc1","name":"Mine"}]}' },
      "whoami": { code: 1, output: "You are not authenticated." },
      "login": (o) => { o.onOutput?.("please visit:\n  https://dash.cloudflare.com/oauth2/device\nand enter the code:\n  WXYZ-1234\n"); return { code: 0, output: "Successfully logged in." }; },
      "deploy": { code: 0, output: URL_OUT },
    });
    h.setup.start();
    await h.settled();
    expect(h.setup.state).toMatchObject({ status: "done" });
    expect(h.deps.openExternal).toHaveBeenCalledWith("https://dash.cloudflare.com/oauth2/device?user_code=WXYZ-1234");
    expect(h.states.some((s) => s.status === "running" && s.step === "signin" && s.signIn?.code === "WXYZ-1234")).toBe(true);
    const put = h.calls.find((c) => c.args[0] === "secret")!;
    expect(put.o.input).toBe(`${h.relay.hostSecret}\n`);
    expect(put.args.join(" ")).not.toContain(h.relay.hostSecret!);
    expect(put.o.accountId).toBe("acc1");
    expect(h.relay).toMatchObject({ url: "https://sutra-relay.aditya.workers.dev", enabled: true });
    expect(h.deployed).toEqual({ name: "sutra-relay", url: "https://sutra-relay.aditya.workers.dev", accountId: "acc1" });
    expect(h.deps.probe).toHaveBeenCalledWith("https://sutra-relay.aditya.workers.dev", h.relay.hostSecret);
  });

  it("asks which account when the sign-in has several, then deploys there", async () => {
    const h = harness({
      "whoami --json": { code: 0, output: '{"accounts":[{"id":"a1","name":"Personal"},{"id":"a2","name":"Work"}]}' },
      "whoami": { code: 0, output: "You are logged in" },
      "deploy": { code: 0, output: URL_OUT },
    });
    h.setup.start();
    await h.settled();
    expect(h.setup.state).toMatchObject({ status: "needs-account", accounts: [{ id: "a1" }, { id: "a2" }] });
    h.setup.chooseAccount("a2");
    await h.settled();
    expect(h.setup.state.status).toBe("done");
    expect(h.calls.find((c) => c.args[0] === "deploy")!.o.accountId).toBe("a2");
  });

  it("creates a workers.dev address when the account has none, then redeploys", async () => {
    let deploys = 0;
    const cfApi = vi.fn(async (_t: string, method: string, path: string) => {
      if (method === "GET" && path.endsWith("/subdomain")) return { status: 404, json: { success: false, errors: [{ code: 10007 }] } };
      if (method === "GET") return { status: 404, json: { success: false, errors: [{ code: 10032 }] } };
      return { status: 200, json: { success: true, result: { subdomain: "sutra-dddddd" } } };
    });
    const h = harness({
      "whoami --json": { code: 0, output: '{"accounts":[{"id":"acc1","name":"Mine"}]}' },
      "whoami": { code: 0, output: "logged in" },
      "auth token": { code: 0, output: '{"type":"oauth","token":"cf-oauth-token-xyz"}' },
      "deploy": () => (++deploys === 1 ? { code: 1, output: "You need to register a workers.dev subdomain before publishing" } : { code: 0, output: URL_OUT }),
    }, { cfApi });
    h.setup.start();
    await h.settled();
    expect(h.setup.state.status).toBe("done");
    expect(deploys).toBe(2);
    expect(cfApi).toHaveBeenCalledWith("cf-oauth-token-xyz", "PUT", "/accounts/acc1/workers/subdomain", { subdomain: "sutra-dddddd" });
  });

  it("fails without saving anything when the secret can't be stored, and never shows a secret", async () => {
    const h = harness({
      "whoami --json": { code: 0, output: '{"accounts":[{"id":"acc1","name":"Mine"}]}' },
      "whoami": { code: 0, output: "logged in" },
      "deploy": { code: 0, output: URL_OUT },
      "secret put": (o) => ({ code: 1, output: `boom ${o.input?.trim()}` }),
    });
    h.setup.start();
    await h.settled();
    const s = h.setup.state;
    expect(s).toMatchObject({ status: "failed" });
    expect(h.relay.url).toBe("");
    expect(h.deployed).toBeNull();
    expect(s.status === "failed" && s.details).toContain("[redacted]");
  });

  it("reports an address that never answers instead of spinning forever", async () => {
    const h = harness({
      "whoami --json": { code: 0, output: '{"accounts":[{"id":"acc1","name":"Mine"}]}' },
      "whoami": { code: 0, output: "logged in" },
      "deploy": { code: 0, output: URL_OUT },
    }, { probe: async () => ({ ok: false, problem: "network", detail: "ECONNRESET" }) });
    h.setup.start();
    await h.settled();
    expect(h.setup.state).toMatchObject({ status: "unreachable" });
    // The connector reaching the relay is proof enough.
    h.setup.relayConnected();
    expect(h.setup.state.status).toBe("done");
  });

  it("removes the Worker from Cloudflare and forgets it here", async () => {
    const h = harness({ "whoami": { code: 0, output: "logged in" }, "delete": { code: 0, output: "Deleted" } });
    h.deps.writeDeployed({ name: "sutra-relay", url: "https://sutra-relay.a.workers.dev", accountId: "acc1" });
    h.deps.saveRelay({ url: "https://sutra-relay.a.workers.dev", hostSecret: "s".repeat(43), enabled: true });
    h.setup.remove();
    await h.settled();
    expect(h.calls.find((c) => c.args[0] === "delete")!.args).toEqual(["delete", "--name", "sutra-relay", "--config", "/tmp/stage/wrangler.json", "--force"]);
    expect(h.relay).toEqual({ url: "", hostSecret: null, enabled: false });
    expect(h.deployed).toBeNull();
    expect(h.setup.state).toMatchObject({ status: "idle", message: "Your relay is removed." });
  });

  it("cancel stops a run and goes back to idle", async () => {
    let release!: (r: RunResult) => void;
    const h = harness({});
    h.deps.prepare = async () => ({
      configPath: "/x", dispose: async () => {},
      run: (_a, o) => new Promise<RunResult>((resolve, reject) => { release = resolve; o?.signal?.addEventListener("abort", () => reject(new Error("aborted"))); }),
    });
    h.setup.start();
    await vi.waitFor(() => expect(release).toBeDefined());
    h.setup.cancel();
    await h.settled();
    expect(h.setup.state.status).toBe("idle");
  });
});
