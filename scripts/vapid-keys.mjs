#!/usr/bin/env node
// Makes the key pair the LMS signs browser push notifications with (VAPID).
// Run once:  node scripts/vapid-keys.mjs
// Then add both values to the Worker as Secrets (Cloudflare dashboard >
// Workers > capitup-lms-web > Settings > Variables and Secrets, type Secret):
//   VAPID_PUBLIC_KEY   VAPID_PRIVATE_KEY
// Keep the private key out of chat, email and git. Changing the keys later
// signs everyone out of push; they turn it on again from the banner.
const { subtle } = globalThis.crypto;
const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await subtle.exportKey("jwk", pair.privateKey);
const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
console.log(`VAPID_PUBLIC_KEY=${b64url(raw)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
