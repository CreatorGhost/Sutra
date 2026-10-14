// Host authentication: the Mac presents the Worker secret HOST_SECRET as a bearer token. Phones are not
// authenticated here — their link to the Mac is end-to-end authenticated and encrypted, so a stranger
// reaching /phone/<id> can only fail the Mac's handshake.

const encoder = new TextEncoder();

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** Compares every byte, so the time taken doesn't reveal where two values first differ. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Whether `Authorization: Bearer <secret>` carries the host secret. Both sides are hashed first so the
 *  comparison always sees 32 bytes, whatever the length of the guess. No secret set → nobody is a host. */
export async function isHostAuthorized(authorization: string | null, secret: string | undefined): Promise<boolean> {
  if (!secret || !authorization) return false;
  const m = /^Bearer (.+)$/.exec(authorization);
  if (!m) return false;
  const [given, expected] = await Promise.all([sha256(m[1]), sha256(secret)]);
  return timingSafeEqual(given, expected);
}
