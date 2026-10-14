// The one live pairing offer (what the QR in Settings → Phones holds) and where a phone can reach this
// Mac. One offer at a time: a new one replaces the old, the right code burns it, too many wrong codes
// burn it too, and it dies on its own after PAIR_CODE_TTL_MS. Pure apart from the default randomness.
import { randomBytes } from "node:crypto";
import type { NetworkInterfaceInfo } from "node:os";
import { makePairCode, normalizeCode, PAIR_CODE_TTL_MS, PAIR_MAX_ATTEMPTS, relayPhoneUrl, type PairOffer, type Route } from "../../src/shared/pairing/protocol";

export type CodeVerdict = "ok" | "bad_code" | "expired";

export class OfferBook {
  private offer: PairOffer | null = null;
  private attempts = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: (n: number) => Uint8Array = (n) => new Uint8Array(randomBytes(n)),
  ) {}

  create(host: { hostId: string; hostName: string; hostKey: string }, routes: Route[]): PairOffer {
    this.offer = { v: 1, ...host, code: makePairCode(this.random), exp: this.now() + PAIR_CODE_TTL_MS, routes };
    this.attempts = 0;
    return this.offer;
  }

  /** The open offer, or null once it has been used, burned, cancelled or has expired. */
  current(): PairOffer | null {
    if (this.offer && this.offer.exp <= this.now()) this.offer = null;
    return this.offer;
  }

  consume(code: string): CodeVerdict {
    const o = this.current();
    if (!o) return "expired";
    if (normalizeCode(code) === o.code) { this.offer = null; return "ok"; }
    if (++this.attempts >= PAIR_MAX_ATTEMPTS) { this.offer = null; return "expired"; }
    return "bad_code";
  }

  cancel(): void { this.offer = null; }
}

/** IPv4 addresses a phone on the same network can dial (no loopback / link-local). */
export function lanAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      if (!out.includes(a.address)) out.push(a.address);
    }
  }
  return out;
}

/** Every route a new offer should list: each LAN address on the running port, then the relay. */
export function offerRoutes(o: { addresses: string[]; port: number | null; relayBase: string | null; hostId: string }): Route[] {
  const routes: Route[] = o.port ? o.addresses.map((ip) => ({ kind: "lan" as const, url: `ws://${ip}:${o.port}` })) : [];
  if (o.relayBase) routes.push({ kind: "relay", url: relayPhoneUrl(o.relayBase, o.hostId) });
  return routes;
}
