import { describe, expect, it } from "vitest";

import {
  base64UrlDecode,
  base64UrlEncode,
  encryptPayload,
  hasVapidKeys,
  sendWebPush,
  vapidAuthorization,
  type VapidKeys,
} from "../web-push";

// The push service only relays bytes; the browser decrypts them. These tests
// play the browser: they decrypt with the subscription's private key exactly
// as RFC 8291 describes, and check the VAPID signature with our public key.

const { subtle } = globalThis.crypto;
const encoder = new TextEncoder();

async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, data as BufferSource));
}

const join = (...parts: (Uint8Array | number[])[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};

/** A browser's push subscription: its key pair and auth secret. */
async function browserSubscription() {
  const pair = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, publicKey, auth, target: { endpoint: "https://push.example.com/send/abc", p256dh: base64UrlEncode(publicKey), auth: base64UrlEncode(auth) } };
}

async function browserDecrypt(body: Uint8Array, sub: Awaited<ReturnType<typeof browserSubscription>>) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idLength = body[20];
  const asPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const serverKey = await subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: serverKey }, sub.pair.privateKey, 256));
  const prkKey = await hmac(sub.auth, ecdh);
  const ikm = await hmac(prkKey, join(encoder.encode("WebPush: info\0"), sub.publicKey, asPublic, [1]));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, join(encoder.encode("Content-Encoding: aes128gcm\0"), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, join(encoder.encode("Content-Encoding: nonce\0"), [1]))).slice(0, 12);
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  return { rs, idLength, plain };
}

async function vapidKeys(): Promise<VapidKeys> {
  const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  const raw = new Uint8Array((await subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { publicKey: base64UrlEncode(raw), privateKey: jwk.d!, subject: "https://lms.capitupindia.com" };
}

describe("web push", () => {
  it("encrypts so that only the subscribed browser can read it", async () => {
    const sub = await browserSubscription();
    const message = JSON.stringify({ title: "T-3 Days: Acme renewal", body: "Renews 15 Nov 2026", url: "/leads/7" });
    const body = await encryptPayload(sub.target, encoder.encode(message));
    const { rs, idLength, plain } = await browserDecrypt(body, sub);
    expect(rs).toBe(4096);
    expect(idLength).toBe(65);
    expect(plain.at(-1)).toBe(2); // The last-record delimiter.
    expect(new TextDecoder().decode(plain.slice(0, -1))).toBe(message);

    // Another browser's keys cannot open it.
    const stranger = await browserSubscription();
    await expect(browserDecrypt(body, stranger)).rejects.toThrow();
  });

  it("signs a VAPID token for the push service's origin with our key", async () => {
    const keys = await vapidKeys();
    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/xyz", keys, Date.UTC(2026, 10, 12));
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(head)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(claims)))).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: Date.UTC(2026, 10, 12) / 1000 + 12 * 3600,
      sub: "https://lms.capitupindia.com",
    });
    const publicKey = await subtle.importKey("raw", base64UrlDecode(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      base64UrlDecode(signature),
      encoder.encode(`${head}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  it("posts the encrypted message and reports gone subscriptions", async () => {
    const keys = await vapidKeys();
    const sub = await browserSubscription();
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: calls.length === 1 ? 201 : 410 });
    }) as unknown as typeof fetch;

    expect(await sendWebPush(sub.target, { title: "Hi" }, keys, fetcher)).toEqual({ ok: true, status: 201, gone: false });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe(sub.target.endpoint);
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers.TTL).toBe("86400");
    expect(headers.Authorization).toMatch(/^vapid t=/);
    const { plain } = await browserDecrypt(calls[0].init.body as Uint8Array, sub);
    expect(JSON.parse(new TextDecoder().decode(plain.slice(0, -1)))).toEqual({ title: "Hi" });

    expect(await sendWebPush(sub.target, { title: "Hi" }, keys, fetcher)).toEqual({ ok: false, status: 410, gone: true });
  });

  it("knows a usable key pair when it sees one", async () => {
    expect(hasVapidKeys(await vapidKeys())).toBe(true);
    expect(hasVapidKeys({ publicKey: "", privateKey: "x", subject: "s" })).toBe(false);
    expect(hasVapidKeys({ publicKey: "abc", privateKey: "def", subject: "s" })).toBe(false);
    expect(hasVapidKeys(undefined)).toBe(false);
  });
});
