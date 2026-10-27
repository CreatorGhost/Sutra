import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import type { Env } from "../src/relay.ts";
import worker from "../src/worker.ts";

const SECRET = "test-secret";

/** A RELAY namespace that records which object each request was routed to. */
function fakeEnv() {
  const routed: { name: string; url: string }[] = [];
  const env = {
    HOST_SECRET: SECRET,
    RELAY: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (req: Request) => { routed.push({ name: id.name, url: req.url }); return new Response("to the object"); },
      }),
    },
  } as unknown as Env;
  return { env, routed };
}

const call = (env: Env, path: string, init: RequestInit = {}) => worker.fetch(new Request("https://sutra-relay.example.workers.dev" + path, init), env);
const upgrade = { upgrade: "websocket" };

describe("worker", () => {
  it("answers health JSON on /", async () => {
    const { env } = fakeEnv();
    const res = await call(env, "/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "sutra-relay", version: pkg.version });
  });

  it("401s /host without or with the wrong secret, never reaching the object", async () => {
    const { env, routed } = fakeEnv();
    expect((await call(env, "/host/mac1", { headers: upgrade })).status).toBe(401);
    expect((await call(env, "/host/mac1", { headers: { ...upgrade, authorization: "Bearer nope" } })).status).toBe(401);
    expect(routed).toEqual([]);
  });

  it("401s every host when no HOST_SECRET is set", async () => {
    const { env } = fakeEnv();
    const noSecret = { ...env, HOST_SECRET: undefined } as Env;
    expect((await call(noSecret, "/host/mac1", { headers: { ...upgrade, authorization: "Bearer " } })).status).toBe(401);
  });

  it("426s a non-upgrade request with the right secret", async () => {
    const { env } = fakeEnv();
    const res = await call(env, "/host/mac1", { headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(426);
    expect(res.headers.get("upgrade")).toBe("websocket");
  });

  it("sends an authorized host and any phone to the object named by the host id", async () => {
    const { env, routed } = fakeEnv();
    await call(env, "/host/mac1", { headers: { ...upgrade, authorization: `Bearer ${SECRET}` } });
    await call(env, "/phone/mac1", { headers: upgrade });
    await call(env, "/phone/other", { headers: upgrade });
    expect(routed.map((r) => r.name)).toEqual(["mac1", "mac1", "other"]);
    expect(new URL(routed[0].url).pathname).toBe("/host/mac1");
  });

  it("rejects bad ids, unknown paths and wrong methods", async () => {
    const { env, routed } = fakeEnv();
    expect((await call(env, "/phone/no.dots", { headers: upgrade })).status).toBe(400);
    expect((await call(env, "/elsewhere")).status).toBe(404);
    expect((await call(env, "/phone/mac1", { method: "POST", headers: upgrade })).status).toBe(405);
    expect((await call(env, "/phone/mac1")).status).toBe(426);
    expect(routed).toEqual([]);
  });
});
