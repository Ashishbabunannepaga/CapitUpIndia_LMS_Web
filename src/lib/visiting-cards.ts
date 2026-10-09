// Visiting card images live in the private R2 bucket under
// "<uploader id>/<uuid>.<ext>" (see src/server/data/cards.ts). They are
// served only through /leads/<id>/card, to people who can see the lead.

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

/** True for a card path this user uploaded (the data layer enforces the same rule for agents). */
export function isOwnCardPath(path: string, userId: string): boolean {
  return PATH_PATTERN.test(path) && path.startsWith(`${userId}/`);
}
