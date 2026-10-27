// End-to-end check against a real Workers runtime: starts `wrangler dev` (or uses RELAY_URL plus
// RELAY_SECRET for a deployed relay), connects as the Mac and as phones with Node's WebSocket, and
// walks the whole stream lifecycle. Run with `npm run e2e`.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  RELAY_MAX_PAYLOAD, RELAY_OP, closePayload, decodeRelayFrame, encodeRelayFrame, readClosePayload,
} from "../../../frontend/src/shared/pairing/relayFrames.ts";

const PORT = 8790 + Math.floor(Math.random() * 100);
const secret = process.env.RELAY_SECRET ?? randomBytes(24).toString("base64");
let base = process.env.RELAY_URL?.replace(/\/+$/, "");
let dev = null;
let stopping = false;

if (!base) {
  base = `http://127.0.0.1:${PORT}`;
  // wrangler's own entry under node (not npx), so killing it stops workerd too.
  dev = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "dev", "--ip", "127.0.0.1", "--port", String(PORT), "--var", `HOST_SECRET:${secret}`], {
    cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  dev.stdout.on("data", (d) => (log += d));
  dev.stderr.on("data", (d) => (log += d));
  dev.on("exit", (code) => { if (code && !stopping) { console.error(log); process.exit(1); } });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { if ((await fetch(base + "/")).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { console.error(log); throw new Error("wrangler dev didn't start"); }
    await new Promise((r) => setTimeout(r, 500));
  }
}
const wsBase = base.replace(/^http/, "ws");
const hostId = "e2e_" + randomBytes(6).toString("hex");
const enc = new TextEncoder();
const dec = new TextDecoder();
let passed = 0;

function check(name, ok, detail = "") {
  if (!ok) throw new Error(`FAIL ${name} ${detail}`);
  passed++;
  console.log(`ok   ${name}`);
}

/** A WebSocket with an awaitable inbox and close. */
function open(path, headers) {
  const ws = new WebSocket(wsBase + path, headers ? { headers } : undefined);
  ws.binaryType = "arraybuffer";
  const inbox = [];
  let wake = null;
  ws.addEventListener("message", (e) => { inbox.push(e.data); wake?.(); });
  const closed = new Promise((r) => ws.addEventListener("close", (e) => { r({ code: e.code, reason: e.reason }); wake?.(); }));
  // A refused handshake fires only "error" in Node's WebSocket, no "close".
  const refused = new Promise((r) => ws.addEventListener("error", () => r(true)));
  const opened = new Promise((r, j) => { ws.addEventListener("open", () => r()); ws.addEventListener("close", () => j(new Error("closed before open"))); });
  opened.catch(() => {});
  async function next(ms = 5000) {
    const end = Date.now() + ms;
    while (!inbox.length) {
      if (ws.readyState === WebSocket.CLOSED) throw new Error(`${path} closed while waiting`);
      if (Date.now() > end) throw new Error(`${path}: no message in ${ms}ms`);
      await new Promise((r) => { wake = r; setTimeout(r, 50); });
    }
    return inbox.shift();
  }
  const frame = async (ms) => decodeRelayFrame(new Uint8Array(await next(ms)));
  return { ws, opened, closed, refused, next, frame };
}
// Under `wrangler dev`, a close the relay starts on a hibernatable socket reaches Node's WebSocket only
// after its 10 s wait for the TCP shutdown (the local proxy keeps the connection open), hence 15 s.
const withTimeout = (p, ms = 15_000) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error("timeout")), ms))]);
const auth = { authorization: `Bearer ${secret}` };

try {
  // ---- HTTP routes ----
  const health = await (await fetch(base + "/")).json();
  check("GET / health", health.ok === true && health.service === "sutra-relay" && typeof health.version === "string", JSON.stringify(health));
  check("host without secret → 401", (await fetch(`${base}/host/${hostId}`)).status === 401);
  check("host with wrong secret → 401", (await fetch(`${base}/host/${hostId}`, { headers: { authorization: "Bearer nope" } })).status === 401);
  check("host with secret, no upgrade → 426", (await fetch(`${base}/host/${hostId}`, { headers: auth })).status === 426);
  check("phone without upgrade → 426", (await fetch(`${base}/phone/${hostId}`)).status === 426);
  check("bad host id → 400", (await fetch(`${base}/phone/bad.id`)).status === 400);
  check("unknown path → 404", (await fetch(`${base}/nope`)).status === 404);

  // ---- WebSockets ----
  const wrong = open(`/host/${hostId}`, { authorization: "Bearer nope" });
  check("host WebSocket with wrong secret is refused", await withTimeout(wrong.refused));

  const early = open(`/phone/${hostId}`);
  const earlyClose = await withTimeout(early.closed);
  check("phone with no Mac connected → 4004 mac offline", earlyClose.code === 4004 && earlyClose.reason === "mac offline", JSON.stringify(earlyClose));

  const host = open(`/host/${hostId}`, auth);
  await withTimeout(host.opened);
  host.ws.send(encodeRelayFrame(RELAY_OP.PING, 0, enc.encode("t1")));
  const pong = await host.frame();
  check("host PING → PONG", pong.op === RELAY_OP.PONG && pong.stream === 0 && dec.decode(pong.payload) === "t1");

  const phone = open(`/phone/${hostId}`);
  await withTimeout(phone.opened);
  const opened = await host.frame();
  check("phone connects → OPEN(stream)", opened.op === RELAY_OP.OPEN && opened.stream > 0);
  const s1 = opened.stream;

  phone.ws.send('{"t":"hello"}');
  const t = await host.frame();
  check("phone text → TEXT(stream)", t.op === RELAY_OP.TEXT && t.stream === s1 && dec.decode(t.payload) === '{"t":"hello"}');
  phone.ws.send(new Uint8Array([1, 2, 3]));
  const b = await host.frame();
  check("phone binary → BIN(stream)", b.op === RELAY_OP.BIN && b.stream === s1 && b.payload.join() === "1,2,3");

  host.ws.send(encodeRelayFrame(RELAY_OP.TEXT, s1, enc.encode('{"t":"welcome"}')));
  const pt = await phone.next();
  check("host TEXT → phone text message", pt === '{"t":"welcome"}');
  host.ws.send(encodeRelayFrame(RELAY_OP.BIN, s1, new Uint8Array([9, 8, 7])));
  const pb = await phone.next();
  check("host BIN → phone binary message", pb instanceof ArrayBuffer && new Uint8Array(pb).join() === "9,8,7");

  const phone2 = open(`/phone/${hostId}`);
  await withTimeout(phone2.opened);
  const opened2 = await host.frame();
  check("second phone gets its own stream", opened2.op === RELAY_OP.OPEN && opened2.stream !== s1);

  phone.ws.close(1000, "bye");
  const c1 = await host.frame();
  const c1p = readClosePayload(c1.payload);
  check("phone closes → CLOSE(stream, code, reason)", c1.op === RELAY_OP.CLOSE && c1.stream === s1 && c1p.code === 1000 && c1p.reason === "bye", JSON.stringify(c1p));

  host.ws.send(encodeRelayFrame(RELAY_OP.CLOSE, opened2.stream, closePayload(4000, "done")));
  const c2 = await withTimeout(phone2.closed);
  check("host CLOSE(stream) → phone closed with that code", c2.code === 4000 && c2.reason === "done", JSON.stringify(c2));

  const phone3 = open(`/phone/${hostId}`);
  await withTimeout(phone3.opened);
  const s3 = (await host.frame()).stream;
  phone3.ws.send(new Uint8Array(RELAY_MAX_PAYLOAD + 1));
  const big = await withTimeout(phone3.closed);
  const bigFrame = await host.frame();
  check("oversize phone message → 1009, CLOSE to Mac", big.code === 1009 && bigFrame.op === RELAY_OP.CLOSE && bigFrame.stream === s3 && readClosePayload(bigFrame.payload).code === 1009, JSON.stringify(big));

  host.ws.send(new Uint8Array([99, 0, 0]));
  host.ws.send(encodeRelayFrame(RELAY_OP.PING, 0));
  check("malformed host frame is dropped, link stays up", (await host.frame()).op === RELAY_OP.PONG);

  const phone4 = open(`/phone/${hostId}`);
  await withTimeout(phone4.opened);
  await host.frame(); // OPEN
  const host2 = open(`/host/${hostId}`, auth);
  await withTimeout(host2.opened);
  const replaced = await withTimeout(host.closed);
  check("new host replaces the old → 4009 replaced", replaced.code === 4009 && replaced.reason === "replaced", JSON.stringify(replaced));
  const p4 = await withTimeout(phone4.closed);
  check("replacement closes the old host's phones → 4004", p4.code === 4004, JSON.stringify(p4));

  const phone5 = open(`/phone/${hostId}`);
  await withTimeout(phone5.opened);
  const o5 = await host2.frame();
  check("stream ids keep counting on the new host", o5.op === RELAY_OP.OPEN && o5.stream > s3);
  host2.ws.close(1000, "quit");
  const p5 = await withTimeout(phone5.closed);
  check("Mac disconnects → phones closed 4004 mac offline", p5.code === 4004 && p5.reason === "mac offline", JSON.stringify(p5));

  console.log(`\n${passed} checks passed against ${dev ? "wrangler dev" : base}`);
} catch (e) {
  console.error(String(e?.stack ?? e));
  process.exitCode = 1;
} finally {
  stopping = true;
  dev?.kill("SIGTERM");
}
