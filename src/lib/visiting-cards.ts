import "server-only";

import { randomUUID } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";

// Visiting card images live in the private "visiting-cards" bucket under
// "<uploader id>/<uuid>.<ext>". Only the server touches the bucket: it
// uploads after checking the file, and signs short-lived URLs only for
// leads the signed-in user can already read (RLS).

const BUCKET = "visiting-cards";

const SIGNATURES: { mime: string; ext: string; test: (b: Uint8Array) => boolean }[] = [
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", ext: "png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  {
    mime: "image/webp",
    ext: "webp",
    test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45,
  },
];

/** The real image type from the file's bytes (never the client's claimed type), or null. */
export function sniffImage(bytes: Uint8Array): { mime: string; ext: string } | null {
  const match = SIGNATURES.find((s) => s.test(bytes));
  return match ? { mime: match.mime, ext: match.ext } : null;
}

const PATH_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

/** True for a card path this user uploaded (the database enforces the same rule for agents). */
export function isOwnCardPath(path: string, userId: string): boolean {
  return PATH_PATTERN.test(path) && path.startsWith(`${userId}/`);
}

export async function uploadCard(userId: string, bytes: Uint8Array, image: { mime: string; ext: string }) {
  const path = `${userId}/${randomUUID()}.${image.ext}`;
  const { error } = await createAdminClient().storage.from(BUCKET).upload(path, bytes, {
    contentType: image.mime,
    upsert: false,
  });
  if (error) throw error;
  return path;
}

/** A 10-minute link to a card. Call only after confirming the user can see the lead. */
export async function signedCardUrl(path: string): Promise<string | null> {
  const { data, error } = await createAdminClient().storage.from(BUCKET).createSignedUrl(path, 600);
  if (error) return null;
  return data.signedUrl;
}
