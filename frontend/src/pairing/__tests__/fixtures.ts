// Test doubles for the phone side of pairing: in-memory sockets wired to a real acceptPhone host, a
// pretend network of routes, and an in-memory filesystem for the queue.
import { generateIdentity } from "../../shared/pairing/crypto";
import { acceptPhone, type HostAuth, type HostConnection, type LinkSocket } from "../../shared/pairing/link";
import type { OpenSocket } from "../routes";
import type { QueueFs } from "../outbox";

/** Two connected in-memory sockets (async delivery, like a real network). */
export function socketPair(): [LinkSocket, LinkSocket] {
  const mk = () => ({ msg: [] as ((d: string | Uint8Array) => void)[], close: [] as ((c?: number, r?: string) => void)[], open: true });
  const a = mk(), b = mk();
  const side = (me: ReturnType<typeof mk>, peer: ReturnType<typeof mk>): LinkSocket => ({
    send: (d) => { if (!me.open || !peer.open) return; const copy = typeof d === "string" ? d : d.slice(); setTimeout(() => peer.msg.forEach((h) => h(copy)), 0); },
    close: (c, r) => { if (!me.open) return; me.open = false; peer.open = false; setTimeout(() => { me.close.forEach((h) => h(c, r)); peer.close.forEach((h) => h(c, r)); }, 0); },
    onMessage: (cb) => { me.msg.push(cb); },
    onClose: (cb) => { me.close.push(cb); },
  });
  return [side(a, b), side(b, a)];
}

/** A Mac that accepts one pairing code and remembers the phones it paired. */
export async function hostFixture(code = "ABCDEFGHJKMN", hostId = "host-1") {
  const identity = await generateIdentity();
  const devices = new Map<string, string>();
  let live = code;
  const auth: HostAuth = {
    hostId, hostName: "Aditya's MacBook", identity,
    consumeCode: (c) => { if (!live) return "expired"; if (c !== live) return "bad_code"; live = ""; return "ok"; },
    registerDevice: async (d) => { const id = `dev-${devices.size + 1}`; devices.set(id, d.linkKey); return id; },
    linkKeyFor: async (id) => devices.get(id) ?? null,
  };
  return { auth, identity, devices };
}

/** Pretend routes: every URL listed as "up" reaches `auth`'s Mac; anything else is unreachable. Each
 *  accepted connection is handed to `onHost` (to serve requests). */
export function network(auth: HostAuth, up: string[], onHost?: (h: HostConnection) => void) {
  const opened: string[] = [];
  const open: OpenSocket = async (url) => {
    opened.push(url);
    if (!up.includes(url)) throw new Error("unreachable");
    const [phone, host] = socketPair();
    void acceptPhone(host, auth).then((h) => onHost?.(h), () => {});
    return phone;
  };
  return { open, opened };
}

export function memoryFs(): QueueFs & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    write: async (p, d) => { files.set(p, d.slice()); },
    read: async (p) => { const d = files.get(p); if (!d) throw new Error(`no such file ${p}`); return d.slice(); },
    list: async (dir) => {
      const names = new Set<string>();
      for (const k of files.keys()) if (k.startsWith(`${dir}/`)) names.add(k.slice(dir.length + 1).split("/")[0]);
      return [...names];
    },
    remove: async (p) => { files.delete(p); },
    removeDir: async (dir) => { for (const k of [...files.keys()]) if (k.startsWith(`${dir}/`)) files.delete(k); },
  };
}

export const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
