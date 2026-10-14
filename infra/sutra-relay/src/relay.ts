// The Durable Object: one per Mac (idFromName(hostId)). Only glue between the Workers runtime and
// RelayHub. Sockets use the Hibernation API, so a relay with nobody talking costs nothing.
//
// The Worker has already routed and authenticated the request (see worker.ts); nothing reaches
// this object any other way. Nothing here logs message contents — they are sealed anyway.
import { DurableObject } from "cloudflare:workers";
import { RelayHub } from "./hub.ts";
import { parseRelayPath } from "./routing.ts";

export interface Env {
  RELAY: DurableObjectNamespace<SutraRelay>;
  /** Worker secret (`wrangler secret put HOST_SECRET`); the Mac presents it as a bearer token. */
  HOST_SECRET?: string;
}

const NEXT_STREAM_KEY = "nextStream";

export class SutraRelay extends DurableObject<Env> {
  private hub!: RelayHub<WebSocket>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Runs on every wake from hibernation too; events wait for it.
    void ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<number>(NEXT_STREAM_KEY);
      this.hub = new RelayHub<WebSocket>({
        accept: (ws, tags) => ctx.acceptWebSocket(ws, tags),
        sockets: (tag) => ctx.getWebSockets(tag),
        refuse: (ws, code, reason) => { ws.accept(); ws.close(code, reason); },
        // Not awaited: the output gate holds the OPEN frame sent next until this write is durable.
        saveNextStream: (next) => void ctx.storage.put(NEXT_STREAM_KEY, next),
      }, stored);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const target = parseRelayPath(new URL(request.url).pathname);
    if (!target) return new Response("Not found", { status: 404 });
    const [client, server] = Object.values(new WebSocketPair());
    if (target.role === "host") this.hub.acceptHost(server);
    else this.hub.acceptPhone(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.hub.onMessage(ws, message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.hub.onClose(ws, code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.hub.onClose(ws, 1011, "error");
  }
}
