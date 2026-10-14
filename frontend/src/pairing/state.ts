// The phone's pairing record: read, create (by scanning the Mac's code), mark removed, forget.
import * as repo from "../local/repo";
import { generateIdentity, newStorageKey } from "../shared/pairing/crypto";
import { connectPhone, type SecureLink } from "../shared/pairing/link";
import type { PairOffer, Route } from "../shared/pairing/protocol";
import { PAIRED_ENGINE_KEY, PAIRED_MODEL_KEY, PAIRING_KEY, readPairing, thisDevice, type Pairing } from "./model";
import { dialRoutes, type OpenSocket } from "./routes";

export async function getPairing(): Promise<Pairing | null> {
  return readPairing(await repo.getSettings());
}

export async function savePairing(p: Pairing): Promise<void> {
  await repo.putSettings({ [PAIRING_KEY]: p });
}

/** The Mac's current routes, learned over the secure link (connection.ts). */
export async function saveRoutes(routes: Route[]): Promise<void> {
  const p = await getPairing();
  if (p) await savePairing({ ...p, routes });
}

/** The Mac removed this phone: stop using it, but keep the record (and the queue) until the user acts. */
export async function markRevoked(): Promise<void> {
  const p = await getPairing();
  if (p && !p.revokedAt) await savePairing({ ...p, revokedAt: new Date().toISOString() });
}

/** Forget the Mac entirely (keys, routes and the phone's engine choice for it). */
export async function forgetPairing(): Promise<void> {
  await repo.putSettings({ [PAIRING_KEY]: null, [PAIRED_ENGINE_KEY]: null, [PAIRED_MODEL_KEY]: null });
}

export interface PairResult { pairing: Pairing; link: SecureLink; route: Route }

/** Pair with the Mac whose code was scanned: a fresh identity for this phone, the one-time code over
 *  the first route that works, then the record is saved. The live link is handed back so the caller
 *  can keep using it. Re-pairing keeps the old storage key, so recordings still waiting stay readable. */
export async function pairWithOffer(offer: PairOffer, opts: { open?: OpenSocket; device?: { deviceName: string; platform: string } } = {}): Promise<PairResult> {
  const identity = await generateIdentity();
  const device = opts.device ?? thisDevice();
  const { result, route } = await dialRoutes(offer.routes, (sock, _route, timeoutMs) => connectPhone(sock, {
    hostId: offer.hostId, hostKey: offer.hostKey, identity, timeoutMs,
    pairing: { code: offer.code, deviceName: device.deviceName, platform: device.platform },
  }), opts.open);
  const previous = await getPairing();
  const pairing: Pairing = {
    hostId: offer.hostId,
    hostName: result.hostName || offer.hostName,
    hostKey: offer.hostKey,
    routes: offer.routes,
    deviceId: result.deviceId,
    linkKey: result.linkKey,
    identity,
    storageKey: previous?.storageKey ?? newStorageKey(),
    pairedAt: new Date().toISOString(),
    revokedAt: null,
  };
  try { await savePairing(pairing); } catch (e) { result.link.close("not saved"); throw e; }
  return { pairing, link: result.link, route };
}
