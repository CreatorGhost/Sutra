// The Mac's pairing server on the local network: a plain WebSocket server on 0.0.0.0, DEFAULT_PAIR_PORT
// when it's free (else any free port — offers always list the port actually bound). Every connection
// becomes a LinkSocket for acceptPhone; nothing is trusted until the encrypted handshake succeeds.
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { LinkSocket } from "../../src/shared/pairing/link";
import { DEFAULT_PAIR_PORT } from "../../src/shared/pairing/protocol";

/** Sealed frames carry ≤ 192 KiB chunks as base64 (~260 KiB); leave room for big text jobs. */
export const LAN_MAX_PAYLOAD = 4 * 1024 * 1024;

const bytesOf = (d: RawData): Uint8Array => {
  if (Array.isArray(d)) return new Uint8Array(Buffer.concat(d));
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
};

/** Adapt a Node `ws` socket (server side, or a client) to the link's socket interface. */
export function nodeSocket(ws: WebSocket): LinkSocket {
  return {
    send: (d) => ws.send(d),
    close: (code, reason) => { try { ws.close(code, reason); } catch { ws.terminate(); } },
    onMessage: (cb) => { ws.on("message", (d, isBinary) => cb(isBinary ? bytesOf(d) : Buffer.from(bytesOf(d)).toString("utf8"))); },
    onClose: (cb) => { ws.on("close", (code, reason) => cb(code, reason.toString())); },
  };
}

export interface LanServer { readonly port: number; close(): Promise<void> }

function listen(port: number, host: string, onSocket: (s: LinkSocket, ws: WebSocket) => void): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port, host, maxPayload: LAN_MAX_PAYLOAD, perMessageDeflate: false });
    wss.once("listening", () => { wss.off("error", reject); resolve(wss); });
    wss.once("error", reject);
    wss.on("connection", (ws) => onSocket(nodeSocket(ws), ws));
  });
}

export async function startLanServer(onSocket: (s: LinkSocket, ws: WebSocket) => void, opts: { port?: number; host?: string } = {}): Promise<LanServer> {
  const host = opts.host ?? "0.0.0.0";
  let wss: WebSocketServer;
  try {
    wss = await listen(opts.port ?? DEFAULT_PAIR_PORT, host, onSocket);
  } catch (e: any) {
    if (e?.code !== "EADDRINUSE" && e?.code !== "EACCES") throw e;
    wss = await listen(0, host, onSocket);
  }
  wss.on("error", () => { /* per-connection errors surface as closes */ });
  const port = (wss.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => resolve());
    }),
  };
}
