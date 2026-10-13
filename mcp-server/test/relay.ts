// Bridge unit test: one primary + peers sharing a port, with a fake Sutra app on the other side.
// Run: npm test. Exits non-zero on the first failed assertion.
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { Bridge } from "../src/bridge.js";

const PORT = 18000 + Math.floor(Math.random() * 2000);
const TOKEN = "a".repeat(64);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** The app side of the protocol (what src/lib/mcpBridge.ts does), reconnecting like the real one. */
function fakeApp() {
  const state = { paired: false, stopped: false, served: 0 };
  const connect = () => {
    if (state.stopped) return;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === "auth") {
        assert.equal(msg.token, TOKEN);
        ws.send(JSON.stringify({ type: "ready", app: "sutra", v: 1, token: TOKEN }));
        state.paired = true;
      } else if (msg.type === "req") {
        state.served++;
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, result: { method: msg.method, params: msg.params } }));
      }
    });
    ws.on("close", () => { state.paired = false; setTimeout(connect, 100); });
    ws.on("error", () => {});
  };
  connect();
  return state;
}
const silence = console.error;
console.error = () => {}; // the bridge logs to stderr; keep test output readable

const a = new Bridge(TOKEN, "127.0.0.1", PORT);
a.start();
await until(() => a.role() === "primary", "A to listen");
const app = fakeApp();
await until(() => app.paired && a.isConnected(), "app to pair with A");

// A second copy (another AI tool) finds the port taken and relays through A.
const b = new Bridge(TOKEN, "127.0.0.1", PORT);
b.start();
await until(() => b.role() === "peer" && b.isConnected(), "B to join A as a peer");
assert.deepEqual(await b.call("list_people", { x: 1 }), { method: "list_people", params: { x: 1 } });
assert.deepEqual(await a.call("list_conversations"), { method: "list_conversations", params: {} });

// A copy configured with a stale token is refused and reports a pairing failure.
const c = new Bridge("b".repeat(64), "127.0.0.1", PORT);
c.start();
await sleep(300);
assert.equal(c.isConnected(), false);
await assert.rejects(c.call("list_people"), /pairing failed/);
c.stop();

// The primary exits (its AI tool closed): the peer takes the port over and the app re-pairs with it.
a.stop();
await until(() => b.role() === "primary", "B to take over the port");
await until(() => app.paired && b.isConnected(), "app to re-pair with B");
assert.deepEqual(await b.call("get_minutes", { conversationId: 3 }), { method: "get_minutes", params: { conversationId: 3 } });

app.stopped = true;
b.stop();
console.error = silence;
console.log(`relay test passed (${app.served} requests served)`);
process.exit(0);
