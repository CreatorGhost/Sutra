// Keeps one secure link to the paired Mac. Dials the best route (routes.ts), keeps it alive with pings,
// and redials with jittered backoff when it drops — at once when the app comes back to the foreground
// or the network returns. If the Mac says it no longer knows this phone (or tells us it removed it),
// the pairing is marked removed and retrying stops; recordings waiting on the phone stay put.
import { connectPhone, HandshakeFailed, type PhoneConnection, type SecureLink } from "../shared/pairing/link";
import type { HostInfo, Route } from "../shared/pairing/protocol";
import type { Pairing } from "./model";
import { dialRoutes, MAC_UNREACHABLE } from "./routes";
import { getPairing, markRevoked } from "./state";

export type MacStatus =
  | { state: "unpaired" }
  | { state: "connecting" }
  | { state: "online"; route: Route["kind"] }
  | { state: "offline"; error: string | null }
  | { state: "revoked" };

export interface MacSnapshot { status: MacStatus; hostInfo: HostInfo | null; pairing: Pairing | null }

export interface SupervisorDeps {
  load(): Promise<Pairing | null>;
  dial(p: Pairing): Promise<{ conn: PhoneConnection; route: Route }>;
  revoke(): Promise<void>;
  random?: () => number;
}

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 60_000;
export const MAC_NOT_REACHABLE = "Your Mac isn't reachable right now. Open Sutra on your Mac and check that both are online, then try again.";
export const MAC_REMOVED = "Your Mac removed this phone. Pair again in Settings → Your Mac.";

/** Delay before redial number `attempt` (0-based): doubling from 1 s to a 60 s cap, with the upper
 *  half jittered so phones that lost the Mac together don't all knock at once. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempt, 16));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export class ConnectionSupervisor {
  private snap: MacSnapshot = { status: { state: "unpaired" }, hostInfo: null, pairing: null };
  private current: SecureLink | null = null;
  private running = false;
  private dialing = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped whenever the pairing changes or we stop, so a dial already in flight is discarded. */
  private generation = 0;
  private listeners = new Set<() => void>();

  constructor(private readonly deps: SupervisorDeps) {}

  snapshot(): MacSnapshot { return this.snap; }
  link(): SecureLink | null { return this.current?.isOpen ? this.current : null; }
  get isOnline(): boolean { return !!this.link(); }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  async start(): Promise<void> {
    this.running = true;
    await this.reload();
  }

  stop(): void {
    this.running = false;
    this.reset();
  }

  /** Re-read the pairing (after unpairing, or a change made elsewhere) and connect if there is one. */
  async reload(): Promise<void> {
    this.reset();
    const gen = this.generation;
    const pairing = await this.deps.load();
    if (gen !== this.generation) return;
    this.set({ pairing, hostInfo: null, status: !pairing ? { state: "unpaired" } : pairing.revokedAt ? { state: "revoked" } : { state: "offline", error: null } });
    if (pairing && !pairing.revokedAt && this.running) this.dial();
  }

  /** A link that was just made by pairing: use it instead of dialling again. */
  adopt(pairing: Pairing, link: SecureLink, route: Route["kind"]): void {
    this.reset();
    this.set({ pairing, hostInfo: null });
    this.attach(link, route);
  }

  /** Try now (app resumed, network back, or someone is waiting) instead of at the next backoff tick. */
  kick(): void {
    const s = this.snap.status.state;
    if (!this.running || this.dialing || s === "online" || s === "unpaired" || s === "revoked") return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.attempt = 0;
    this.dial();
  }

  /** The link, waiting up to `timeoutMs` for the Mac; fails with a message the user can act on. */
  whenOnline(timeoutMs = 20_000): Promise<SecureLink> {
    const now = this.link();
    if (now) return Promise.resolve(now);
    const s = this.snap.status.state;
    if (s === "revoked") return Promise.reject(new Error(MAC_REMOVED));
    if (s === "unpaired") return Promise.reject(new Error("This phone isn't paired with a Mac."));
    this.kick();
    return new Promise((resolve, reject) => {
      const done = (fn: () => void) => { clearTimeout(timer); off(); fn(); };
      const timer = setTimeout(() => done(() => reject(new Error(MAC_NOT_REACHABLE))), timeoutMs);
      const off = this.subscribe(() => {
        const l = this.link();
        if (l) done(() => resolve(l));
        else if (this.snap.status.state === "revoked") done(() => reject(new Error(MAC_REMOVED)));
        else if (this.snap.status.state === "unpaired") done(() => reject(new Error("This phone isn't paired with a Mac.")));
      });
    });
  }

  private reset(): void {
    this.generation++;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.attempt = 0;
    this.dialing = false;
    const l = this.current;
    this.current = null;
    l?.close("reset");
  }

  private set(patch: Partial<MacSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of [...this.listeners]) { try { fn(); } catch { /* listener bug */ } }
  }

  private dial(): void {
    const pairing = this.snap.pairing;
    if (!pairing || this.dialing) return;
    const gen = this.generation;
    this.dialing = true;
    this.set({ status: { state: "connecting" } });
    this.deps.dial(pairing).then(
      ({ conn, route }) => {
        if (gen !== this.generation) { conn.link.close("stale"); return; }
        this.dialing = false;
        this.attach(conn.link, route.kind);
      },
      (e) => {
        if (gen !== this.generation) return;
        this.dialing = false;
        if (e instanceof HandshakeFailed && e.code === "unknown_device") { void this.revoked(); return; }
        this.set({ status: { state: "offline", error: e instanceof HandshakeFailed ? e.message : MAC_UNREACHABLE } });
        this.schedule();
      },
    );
  }

  private attach(link: SecureLink, route: Route["kind"]): void {
    this.current = link;
    this.attempt = 0;
    link.startKeepalive();
    link.onEvent((e) => {
      if (e === "host.changed") void this.refreshInfo(link);
      else if (e === "revoked") void this.revoked();
    });
    link.onClose(() => {
      if (this.current !== link) return;
      this.current = null;
      this.set({ status: { state: "offline", error: null } });
      this.schedule();
    });
    if (!link.isOpen) return; // closed before we got here; onClose above already rescheduled
    this.set({ status: { state: "online", route } });
    void this.refreshInfo(link);
  }

  private async refreshInfo(link: SecureLink): Promise<void> {
    try {
      const info = await link.request("host.info", {}, 15_000);
      if (this.current === link) this.set({ hostInfo: info });
    } catch { /* an older or busy Mac — keep what we had */ }
  }

  private schedule(): void {
    if (!this.running || this.timer || this.snap.status.state === "revoked") return;
    const delay = backoffDelay(this.attempt++, this.deps.random);
    this.timer = setTimeout(() => { this.timer = null; this.dial(); }, delay);
  }

  private async revoked(): Promise<void> {
    if (this.snap.status.state === "revoked") return;
    this.reset();
    const pairing = this.snap.pairing ? { ...this.snap.pairing, revokedAt: new Date().toISOString() } : null;
    this.set({ status: { state: "revoked" }, pairing, hostInfo: null });
    try { await this.deps.revoke(); } catch { /* the in-memory state already stops us */ }
  }
}

/** The real dialler: LAN first, then relay, reconnecting with the stored link key. */
export function dialPairing(p: Pairing, open?: Parameters<typeof dialRoutes>[2]): Promise<{ conn: PhoneConnection; route: Route }> {
  return dialRoutes(p.routes, (sock, _route, timeoutMs) => connectPhone(sock, {
    hostId: p.hostId, hostKey: p.hostKey, identity: p.identity, deviceId: p.deviceId, linkKey: p.linkKey, timeoutMs,
  }), open).then(({ result, route }) => ({ conn: result, route }));
}

let shared: ConnectionSupervisor | null = null;
/** The app's one connection to the paired Mac (created on first use; started by the pairing runtime). */
export function macConnection(): ConnectionSupervisor {
  return (shared ??= new ConnectionSupervisor({ load: getPairing, dial: (p) => dialPairing(p), revoke: markRevoked }));
}
