// Web Push (RFC 8030) from a Worker, with WebCrypto only: no Node crypto and
// no library. Each message is encrypted for one browser (RFC 8291,
// aes128gcm) and signed with our VAPID key (RFC 8292) so the push service
// (Google, Mozilla, Apple) accepts it.
//
// Keys: VAPID_PUBLIC_KEY (65-byte uncompressed P-256 point) and
// VAPID_PRIVATE_KEY (32-byte scalar), both base64url, made once with
// `node scripts/vapid-keys.mjs` and stored as Worker secrets.

export type VapidKeys = { publicKey: string; privateKey: string; subject: string };
export type PushTarget = { endpoint: string; p256dh: string; auth: string };
export type PushResult = { ok: boolean; status: number; /** The browser unsubscribed: forget it. */ gone: boolean };

const encoder = new TextEncoder();
/** Push services accept up to 4 KB; keep the plaintext well inside one 4096-byte record. */
export const MAX_PAYLOAD_BYTES = 3000;
const RECORD_SIZE = 4096;

type Bytes = Uint8Array<ArrayBuffer>;

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Bytes {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(...parts: (Uint8Array | number[])[]): Bytes {
  const length = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hmacSha256(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** True when both keys are present and look like a P-256 key pair. */
export function hasVapidKeys(keys: Partial<VapidKeys> | null | undefined): keys is VapidKeys {
  try {
    return Boolean(
      keys?.publicKey &&
        keys.privateKey &&
        keys.subject &&
        base64UrlDecode(keys.publicKey).length === 65 &&
        base64UrlDecode(keys.privateKey).length === 32,
    );
  } catch {
    return false;
  }
}

async function vapidSigningKey(keys: VapidKeys): Promise<CryptoKey> {
  const point = base64UrlDecode(keys.publicKey);
  if (point.length !== 65 || point[0] !== 4) throw new Error("VAPID_PUBLIC_KEY is not an uncompressed P-256 key.");
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: keys.privateKey, x: base64UrlEncode(point.slice(1, 33)), y: base64UrlEncode(point.slice(33)), ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/** The Authorization header for one push service (RFC 8292): a 12-hour ES256 JWT plus our public key. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, now = Date.now()): Promise<string> {
  const json = (value: unknown) => base64UrlEncode(encoder.encode(JSON.stringify(value)));
  const unsigned = `${json({ typ: "JWT", alg: "ES256" })}.${json({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: keys.subject,
  })}`;
  // WebCrypto's ECDSA signature is already r || s, the JWS (ES256) format.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await vapidSigningKey(keys), encoder.encode(unsigned)),
  );
  return `vapid t=${unsigned}.${base64UrlEncode(signature)}, k=${keys.publicKey}`;
}

/** Encrypts a payload for one browser subscription (RFC 8291, "aes128gcm" content coding). */
export async function encryptPayload(target: Pick<PushTarget, "p256dh" | "auth">, payload: Uint8Array): Promise<Bytes> {
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error("Push payload too large.");
  const uaPublic = base64UrlDecode(target.p256dh);
  const authSecret = base64UrlDecode(target.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("Bad push subscription keys.");

  // A fresh key pair per message (the "application server" keys of RFC 8291).
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  const browserKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: browserKey }, local.privateKey, 256));

  // HKDF (SHA-256), written out: each expand here needs only one block.
  const prkKey = await hmacSha256(authSecret, ecdhSecret);
  const ikm = await hmacSha256(prkKey, concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic, [1]));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, ikm);
  const cek = (await hmacSha256(prk, concat(encoder.encode("Content-Encoding: aes128gcm\0"), [1]))).slice(0, 16);
  const nonce = (await hmacSha256(prk, concat(encoder.encode("Content-Encoding: nonce\0"), [1]))).slice(0, 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record: the payload, then the 0x02 "last record" delimiter, no padding.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concat(payload, [2])));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/** Sends one push message. Never throws for a refused message; a network failure does throw. */
export async function sendWebPush(
  target: PushTarget,
  message: unknown,
  keys: VapidKeys,
  fetcher: typeof fetch = fetch,
): Promise<PushResult> {
  const body = await encryptPayload(target, encoder.encode(JSON.stringify(message)));
  const response = await fetcher(target.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(target.endpoint, keys),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      // Keep it for a day if the phone is off; reminders older than that are stale.
      TTL: "86400",
      Urgency: "high",
    },
    body,
  });
  // Drain the body so the Worker can reuse the connection.
  await response.arrayBuffer().catch(() => undefined);
  return { ok: response.ok, status: response.status, gone: response.status === 404 || response.status === 410 };
}
