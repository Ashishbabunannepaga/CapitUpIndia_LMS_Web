import "server-only";

import { and, eq } from "drizzle-orm";

import { sniffImage } from "@/lib/visiting-cards";

import { leads, visitingCardPreviews } from "../db/schema";
import { isAdmin, type Actor } from "./actor";
import { auditInsert } from "./audit";
import type { DataContext } from "./context";
import { InvalidInputError } from "./errors";

// Visiting-card photos in the private R2 bucket, stored as
// "<uploader id>/<random id>.<ext>". Nothing in the bucket is public: a card
// is read only through cardForLead(), for someone who can see the lead.
//
// Each card also gets a small compressed copy (resized in the browser) in the
// visiting_card_previews table under the same path. The lead page shows that
// copy, so it loads instantly from D1; the full photo stays in R2.

export const MAX_CARD_BYTES = 5 * 1024 * 1024;
/** Matches the visiting_card_previews_size CHECK. */
export const MAX_CARD_PREVIEW_BYTES = 300 * 1024;

/**
 * Stores a card photo and its compressed preview. The type comes from the
 * bytes, never from the client. Without a preview, a photo already under the
 * preview limit is its own preview. Returns the card's path.
 */
export async function uploadCard(
  ctx: DataContext,
  actor: Actor,
  bytes: Uint8Array,
  preview?: Uint8Array | null,
): Promise<string> {
  if (bytes.byteLength === 0) throw new InvalidInputError("The photo is empty.");
  if (bytes.byteLength > MAX_CARD_BYTES) throw new InvalidInputError("Use a photo under 5 MB.");
  const image = sniffImage(bytes);
  if (!image) throw new InvalidInputError("Use a JPEG, PNG or WebP photo.");

  let small: { bytes: Uint8Array; mime: string } | null = null;
  if (preview && preview.byteLength > 0) {
    const previewImage = sniffImage(preview);
    if (!previewImage) throw new InvalidInputError("The card preview is not a JPEG, PNG or WebP image.");
    if (preview.byteLength > MAX_CARD_PREVIEW_BYTES) throw new InvalidInputError("The card preview is too large.");
    small = { bytes: preview, mime: previewImage.mime };
  } else if (bytes.byteLength <= MAX_CARD_PREVIEW_BYTES) {
    small = { bytes, mime: image.mime };
  }

  const path = `${actor.id}/${crypto.randomUUID()}.${image.ext}`;
  await ctx.cards.put(path, bytes, { httpMetadata: { contentType: image.mime } });
  if (small) {
    await ctx.db.insert(visitingCardPreviews).values({
      path,
      mime: small.mime,
      data: Buffer.from(small.bytes),
      byte_size: small.bytes.byteLength,
      created_by: actor.id,
    });
  }
  return path;
}

export type CardImage = { body: ReadableStream | Uint8Array<ArrayBuffer>; contentType: string };

/**
 * The card attached to a lead the caller can see, or null: the compressed
 * preview when there is one, else (or with `full`) the photo from R2.
 */
export async function cardForLead(
  ctx: DataContext,
  actor: Actor,
  leadId: number,
  opts: { full?: boolean } = {},
): Promise<CardImage | null> {
  const lead = await ctx.db.query.leads.findFirst({
    columns: { visiting_card_path: true },
    where: and(eq(leads.id, leadId), isAdmin(actor) ? undefined : eq(leads.assigned_agent_id, actor.id)),
  });
  const path = lead?.visiting_card_path;
  if (!path) return null;
  if (!opts.full) {
    const preview = await ctx.db.query.visitingCardPreviews.findFirst({ where: eq(visitingCardPreviews.path, path) });
    if (preview) return { body: new Uint8Array(preview.data), contentType: preview.mime };
  }
  const object = await ctx.cards.get(path);
  if (!object) return null;
  return { body: object.body, contentType: object.httpMetadata?.contentType ?? "application/octet-stream" };
}

/**
 * Attaches a new card photo to a lead the caller can see (replacing any
 * earlier one, which stays in storage). Agents only reach their own leads.
 */
export async function attachCardToLead(
  ctx: DataContext,
  actor: Actor,
  leadId: number,
  bytes: Uint8Array,
  preview?: Uint8Array | null,
): Promise<void> {
  const before = await ctx.db.query.leads.findFirst({
    where: and(eq(leads.id, leadId), isAdmin(actor) ? undefined : eq(leads.assigned_agent_id, actor.id)),
  });
  if (!before) throw new InvalidInputError("That lead no longer exists or isn't yours.");
  const path = await uploadCard(ctx, actor, bytes, preview);
  const after = { ...before, visiting_card_path: path, updated_at: new Date().toISOString() };
  await ctx.db.batch([
    ctx.db.update(leads).set({ visiting_card_path: path, updated_at: after.updated_at }).where(eq(leads.id, leadId)),
    auditInsert(ctx, actor, "leads", leadId, "UPDATE", before, after),
  ]);
}
