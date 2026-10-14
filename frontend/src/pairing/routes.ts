// Picking a way to the Mac. The pairing code lists every route it can be reached on: its LAN
// address(es) and, if set up, the user's own relay. LAN is tried first — every LAN address at once,
// briefly, since on the same Wi-Fi one answers in milliseconds and the others never do — then the relay.
// The first route that completes the handshake wins.
import { browserSocket, HandshakeFailed, type LinkSocket } from "../shared/pairing/link";
import type { Route } from "../shared/pairing/protocol";

export const LAN_OPEN_MS = 2_500;
export const LAN_HANDSHAKE_MS = 8_000;
export const RELAY_OPEN_MS = 10_000;
export const RELAY_HANDSHAKE_MS = 15_000;

export const MAC_UNREACHABLE = "Couldn't reach your Mac. Check that it's on with Sutra open, and that your phone is on the same Wi-Fi (or your relay is set up).";

/** Opens a socket and resolves once it can send. */
export type OpenSocket = (url: string, timeoutMs: number) => Promise<LinkSocket>;

export const openWebSocket: OpenSocket = (url, timeoutMs) => new Promise((resolve, reject) => {
  let ws: WebSocket;
  try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
  let settled = false;
  const fail = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { ws.close(); } catch { /* not open yet */ }
    reject(new Error("unreachable"));
  };
  const timer = setTimeout(fail, timeoutMs);
  ws.addEventListener("open", () => { if (settled) return; settled = true; clearTimeout(timer); resolve(browserSocket(ws)); }, { once: true });
  ws.addEventListener("error", fail, { once: true });
  ws.addEventListener("close", fail, { once: true });
});

/** Failures that another route can't fix (the Mac itself said no). */
const FINAL = new Set(["bad_code", "expired", "unknown_device", "version", "busy"]);
const isFinal = (e: unknown) => e instanceof HandshakeFailed && FINAL.has(e.code);

/** The first of several sockets to open; the rest are closed when they do. */
function openFirst(routes: Route[], timeoutMs: number, open: OpenSocket): Promise<{ route: Route; sock: LinkSocket }> {
  return new Promise((resolve, reject) => {
    let left = routes.length;
    let won = false;
    for (const route of routes) {
      open(route.url, timeoutMs).then(
        (sock) => { if (won) { sock.close(1000, "another route won"); return; } won = true; resolve({ route, sock }); },
        () => { if (--left === 0 && !won) reject(new Error("unreachable")); },
      );
    }
  });
}

/** Connect over the best route: LAN (all addresses in parallel), then the relay. `handshake` runs on
 *  the opened socket; a handshake the Mac refused (wrong code, removed phone, …) ends the search. */
export async function dialRoutes<T>(
  routes: Route[],
  handshake: (sock: LinkSocket, route: Route, timeoutMs: number) => Promise<T>,
  open: OpenSocket = openWebSocket,
): Promise<{ result: T; route: Route }> {
  let last: unknown = null;
  let lan = routes.filter((r) => r.kind === "lan");
  while (lan.length) {
    let opened: { route: Route; sock: LinkSocket };
    try { opened = await openFirst(lan, LAN_OPEN_MS, open); } catch { break; }
    const { route, sock } = opened;
    lan = lan.filter((r) => r !== route);
    try { return { result: await handshake(sock, route, LAN_HANDSHAKE_MS), route }; }
    catch (e) { if (isFinal(e)) throw e; last = e; sock.close(1000, "handshake failed"); }
  }
  for (const route of routes.filter((r) => r.kind === "relay")) {
    let sock: LinkSocket;
    try { sock = await open(route.url, RELAY_OPEN_MS); } catch { continue; }
    try { return { result: await handshake(sock, route, RELAY_HANDSHAKE_MS), route }; }
    catch (e) { if (isFinal(e)) throw e; last = e; sock.close(1000, "handshake failed"); }
  }
  // A route that answered as a different Mac says more than "unreachable".
  if (last instanceof HandshakeFailed && last.code === "host_mismatch") throw last;
  throw new HandshakeFailed("closed", MAC_UNREACHABLE);
}
