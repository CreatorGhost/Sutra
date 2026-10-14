// Routing decisions for the relay Worker, free of Workers APIs so plain Node tests cover them.
//
//   GET /                  health JSON
//   GET /host/<hostId>     the Mac's one WebSocket (Authorization: Bearer <HOST_SECRET>)
//   GET /phone/<hostId>    a phone's WebSocket (no auth here; the link itself is end-to-end)

/** Same alphabet as the Mac's host ids (base64url), so they need no escaping in the path. */
const HOST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const isValidHostId = (id: string) => HOST_ID.test(id);

export type Role = "host" | "phone";

/** `/host/<id>` or `/phone/<id>` → its parts; anything else (including a bad id) → null. */
export function parseRelayPath(pathname: string): { role: Role; hostId: string } | null {
  const m = /^\/(host|phone)\/([^/]*)$/.exec(pathname);
  if (!m || !isValidHostId(m[2])) return null;
  return { role: m[1] as Role, hostId: m[2] };
}

export type Route =
  | { kind: "health" }
  | { kind: "connect"; role: Role; hostId: string }
  | { kind: "reject"; status: 400 | 401 | 404 | 405 | 426 };

export interface RouteInput {
  method: string;
  pathname: string;
  upgrade: string | null;
  /** Whether the Authorization header carried the host secret (only checked on /host/ paths). */
  hostAuthorized: boolean;
}

export function routeRequest(i: RouteInput): Route {
  if (i.pathname === "/") return i.method === "GET" || i.method === "HEAD" ? { kind: "health" } : { kind: "reject", status: 405 };
  if (!/^\/(host|phone)\/[^/]*$/.test(i.pathname)) return { kind: "reject", status: 404 };
  const target = parseRelayPath(i.pathname);
  if (!target) return { kind: "reject", status: 400 };
  if (i.method !== "GET") return { kind: "reject", status: 405 };
  // 401 before 426: a plain `curl /host/<id>` with the right secret answers 426, which proves the
  // secret matches without opening a WebSocket.
  if (target.role === "host" && !i.hostAuthorized) return { kind: "reject", status: 401 };
  if (i.upgrade?.toLowerCase() !== "websocket") return { kind: "reject", status: 426 };
  return { kind: "connect", ...target };
}
