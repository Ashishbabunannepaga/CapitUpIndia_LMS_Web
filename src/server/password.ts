import "server-only";

import { verifyPassword as verifyScrypt } from "better-auth/crypto";

// Password hashing that fits a Cloudflare Worker.
//
// Better Auth's default is scrypt with N=16384, r=16: about 32 MB of memory
// per hash. On a Worker that shares 128 MB with the whole Next.js app, a
// sign-in can push the isolate over its limit and fail with error 1102.
// PBKDF2-SHA256 through Web Crypto runs natively with almost no memory.
// Workers cap PBKDF2 at 100,000 iterations.
//
// Stored format: pbkdf2-sha256$<iterations>$<salt hex>$<key hex>.
// Older accounts still hold scrypt hashes ("<salt>:<key>"); those still
// verify, and sign-in upgrades them (see upgradeLegacyPassword in
// src/server/data/sessions.ts).

const PREFIX = "pbkdf2-sha256";
const ITERATIONS = 100_000;
const KEY_BYTES = 32;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) return null;
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password.normalize("NFKC")), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function isLegacyPasswordHash(hash: string): boolean {
  return !hash.startsWith(`${PREFIX}$`);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derive(password, salt, ITERATIONS);
  return `${PREFIX}$${ITERATIONS}$${toHex(salt)}$${toHex(key)}`;
}

export async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  if (isLegacyPasswordHash(hash)) return verifyScrypt({ hash, password });
  const [, rounds, saltHex, keyHex] = hash.split("$");
  const iterations = Number(rounds);
  const salt = saltHex ? fromHex(saltHex) : null;
  const expected = keyHex ? fromHex(keyHex) : null;
  if (!salt || !expected || !Number.isInteger(iterations) || iterations < 1 || iterations > ITERATIONS) return false;
  return sameBytes(await derive(password, salt, iterations), expected);
}
