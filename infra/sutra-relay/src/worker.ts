// Sutra relay Worker: lets a paired phone reach Sutra on the user's Mac from anywhere. Deployed by the
// user to their own Cloudflare account (docs/RELAY.md). It only forwards frames that are already
// end-to-end encrypted between phone and Mac; it can't read or forge them.
import { version } from "../package.json";
import { isHostAuthorized } from "./auth.ts";
import type { Env } from "./relay.ts";
import { routeRequest } from "./routing.ts";

export { SutraRelay } from "./relay.ts";

const TEXT = { "content-type": "text/plain; charset=utf-8" };

const REJECT: Record<400 | 401 | 404 | 405 | 426, { body: string; headers?: Record<string, string> }> = {
  400: { body: "Bad host id" },
  401: { body: "Unauthorized", headers: { "www-authenticate": "Bearer" } },
  404: { body: "Not found" },
  405: { body: "Method not allowed", headers: { allow: "GET" } },
  426: { body: "WebSocket upgrade required", headers: { upgrade: "websocket" } },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = routeRequest({
      method: request.method,
      pathname: url.pathname,
      upgrade: request.headers.get("upgrade"),
      hostAuthorized: url.pathname.startsWith("/host/") && (await isHostAuthorized(request.headers.get("authorization"), env.HOST_SECRET)),
    });
    switch (route.kind) {
      case "health":
        return Response.json({ ok: true, service: "sutra-relay", version }, { headers: { "cache-control": "no-store" } });
      case "reject": {
        const r = REJECT[route.status];
        return new Response(r.body, { status: route.status, headers: { ...TEXT, ...r.headers } });
      }
      case "connect":
        return env.RELAY.get(env.RELAY.idFromName(route.hostId)).fetch(request);
    }
  },
} satisfies ExportedHandler<Env>;
