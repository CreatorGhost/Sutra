// Phone ↔ Mac pairing crypto. WebCrypto only (Electron main, the Mac renderer and the phone WebView
// all have crypto.subtle), so one implementation runs on both ends.
//
//   identity   — a long-lived ECDH P-256 key pair per device (the Mac's public key travels in the QR).
//   link key   — HKDF(ECDH(mine, theirs)) fixed at pairing and stored on both sides. Nothing else is
//                ever needed to talk again, and a relay in the middle never learns it.
//   session    — every connection mixes fresh nonces from both ends into the link key, giving one
//                AES-GCM key per direction. Frames carry a strictly increasing counter in the IV, so a
//                replayed, reordered or reflected frame fails to open.
export type Bytes = Uint8Array;

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("Secure pairing needs WebCrypto (crypto.subtle).");
  return s;
};
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- encodings ----
export function b64u(bytes: Bytes): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64u(s: string): Bytes {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
export const utf8 = (s: string): Bytes => enc.encode(s);
export const fromUtf8 = (b: Bytes): string => dec.decode(b);
export function randomBytes(n: number): Bytes {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}
function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** Copy into a fresh ArrayBuffer-backed view (WebCrypto's BufferSource typing rejects SharedArrayBuffer views). */
const buf = (b: Bytes): Uint8Array<ArrayBuffer> => { const c = new Uint8Array(b.length); c.set(b); return c; };

// ---- identities ----
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

export interface Identity { publicKey: string; privateJwk: JsonWebKey }

/** A new long-lived identity. Store `privateJwk` somewhere private; `publicKey` can be shown to anyone. */
export async function generateIdentity(): Promise<Identity> {
  const kp = await subtle().generateKey(ECDH, true, ["deriveBits"]) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle().exportKey("raw", kp.publicKey));
  return { publicKey: b64u(raw), privateJwk: await subtle().exportKey("jwk", kp.privateKey) };
}

async function sharedSecret(privateJwk: JsonWebKey, theirPublic: string): Promise<Bytes> {
  const priv = await subtle().importKey("jwk", privateJwk, ECDH, false, ["deriveBits"]);
  const pubRaw = fromB64u(theirPublic);
  if (pubRaw.length !== 65 || pubRaw[0] !== 4) throw new Error("Not a P-256 public key.");
  const pub = await subtle().importKey("raw", buf(pubRaw), ECDH, false, []);
  return new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: pub }, priv, 256));
}

async function hkdf(ikm: Bytes, salt: Bytes, info: string, length = 32): Promise<Bytes> {
  const k = await subtle().importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(utf8(info)) }, k, length * 8));
}

/** The long-term key both ends store after pairing (base64url of 32 bytes). `hostId` and the device's
 *  public key are bound in, so a key derived for one pairing is useless for any other. */
export async function deriveLinkKey(myPrivateJwk: JsonWebKey, theirPublic: string, hostId: string, devicePublic: string): Promise<string> {
  return b64u(await hkdf(await sharedSecret(myPrivateJwk, theirPublic), utf8(`${hostId}|${devicePublic}`), "sutra-link-v1"));
}

// ---- one-shot box (the pairing request) ----
async function aesKey(raw: Bytes): Promise<CryptoKey> {
  return subtle().importKey("raw", buf(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
const AAD = utf8("sutra-pair/1");

/** Encrypt the one-time pairing code to the Mac, so a relay in the middle never sees it. */
export async function sealPairBox(myPrivateJwk: JsonWebKey, theirPublic: string, payload: unknown): Promise<string> {
  const key = await aesKey(await hkdf(await sharedSecret(myPrivateJwk, theirPublic), utf8("pair"), "sutra-pair-v1"));
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(AAD) }, key, buf(utf8(JSON.stringify(payload)))));
  return b64u(concat(iv, ct));
}
export async function openPairBox(myPrivateJwk: JsonWebKey, theirPublic: string, box: string): Promise<unknown> {
  const key = await aesKey(await hkdf(await sharedSecret(myPrivateJwk, theirPublic), utf8("pair"), "sutra-pair-v1"));
  const raw = fromB64u(box);
  if (raw.length < 28) throw new Error("Pairing request is malformed.");
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: buf(raw.subarray(0, 12)), additionalData: buf(AAD) }, key, buf(raw.subarray(12)));
  return JSON.parse(fromUtf8(new Uint8Array(pt)));
}

// ---- sessions ----
export type Role = "phone" | "host";
const DIR = { phone: 1, host: 2 } as const; // who SENDS the frame

export interface SessionKeys { send: CryptoKey; recv: CryptoKey; sendDir: number; recvDir: number }

/** Per-connection keys from the stored link key and both sides' fresh nonces. */
export async function deriveSessionKeys(linkKey: string, phoneNonce: string, hostNonce: string, role: Role): Promise<SessionKeys> {
  const salt = concat(fromB64u(phoneNonce), fromB64u(hostNonce));
  const ikm = fromB64u(linkKey);
  const p2h = await aesKey(await hkdf(ikm, salt, "sutra-session-v1 phone->host"));
  const h2p = await aesKey(await hkdf(ikm, salt, "sutra-session-v1 host->phone"));
  return role === "phone"
    ? { send: p2h, recv: h2p, sendDir: DIR.phone, recvDir: DIR.host }
    : { send: h2p, recv: p2h, sendDir: DIR.host, recvDir: DIR.phone };
}

const SESSION_AAD = utf8("sutra-link/1");

/** Encrypts and decrypts one connection's frames. Frame = iv(12: 4-byte direction ‖ 8-byte counter) ‖ AES-GCM ciphertext. */
export class FrameCipher {
  private sendCtr = 0n;
  private recvCtr = -1n;
  constructor(private readonly keys: SessionKeys) {}

  async seal(plain: Bytes): Promise<Bytes> {
    const iv = new Uint8Array(12);
    const dv = new DataView(iv.buffer);
    dv.setUint32(0, this.keys.sendDir);
    dv.setBigUint64(4, this.sendCtr++);
    const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: buf(SESSION_AAD) }, this.keys.send, buf(plain)));
    return concat(iv, ct);
  }

  /** Throws on a tampered, replayed, reordered or reflected frame. */
  async open(frame: Bytes): Promise<Bytes> {
    if (frame.length < 28) throw new Error("Frame too short.");
    const iv = buf(frame.subarray(0, 12));
    const dv = new DataView(iv.buffer);
    if (dv.getUint32(0) !== this.keys.recvDir) throw new Error("Frame from the wrong direction.");
    const ctr = dv.getBigUint64(4);
    if (ctr <= this.recvCtr) throw new Error("Replayed or reordered frame.");
    const pt = await subtle().decrypt({ name: "AES-GCM", iv, additionalData: buf(SESSION_AAD) }, this.keys.recv, buf(frame.subarray(12)));
    this.recvCtr = ctr;
    return new Uint8Array(pt);
  }
}

// ---- at rest ----
/** A random AES key for encrypting things kept on disk (the phone's queued audio). */
export function newStorageKey(): string { return b64u(randomBytes(32)); }

export async function sealAtRest(storageKey: string, plain: Bytes): Promise<Bytes> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: buf(iv) }, await aesKey(fromB64u(storageKey)), buf(plain)));
  return concat(iv, ct);
}
export async function openAtRest(storageKey: string, sealed: Bytes): Promise<Bytes> {
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: buf(sealed.subarray(0, 12)) }, await aesKey(fromB64u(storageKey)), buf(sealed.subarray(12)));
  return new Uint8Array(pt);
}
