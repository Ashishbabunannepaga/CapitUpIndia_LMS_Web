import "server-only";

import { and, eq } from "drizzle-orm";

import { sniffImage } from "@/lib/visiting-cards";

import { leads } from "../db/schema";
import { isAdmin, type Actor } from "./actor";
import type { DataContext } from "./context";
import { InvalidInputError } from "./errors";

// Visiting-card photos in the private R2 bucket, stored as
// "<uploader id>/<random id>.<ext>". Nothing in the bucket is public: a card
// is read only through cardForLead(), for someone who can see the lead.

export const MAX_CARD_BYTES = 5 * 1024 * 1024;

/** Stores a card photo. The type comes from the bytes, never from the client. Returns its path. */
export async function uploadCard(ctx: DataContext, actor: Actor, bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength === 0) throw new InvalidInputError("The photo is empty.");
  if (bytes.byteLength > MAX_CARD_BYTES) throw new InvalidInputError("Use a photo under 5 MB.");
  const image = sniffImage(bytes);
  if (!image) throw new InvalidInputError("Use a JPEG, PNG or WebP photo.");
  const path = `${actor.id}/${crypto.randomUUID()}.${image.ext}`;
  await ctx.cards.put(path, bytes, { httpMetadata: { contentType: image.mime } });
  return path;
}

/** The card attached to a lead the caller can see, or null. */
export async function cardForLead(ctx: DataContext, actor: Actor, leadId: number): Promise<R2ObjectBody | null> {
  const lead = await ctx.db.query.leads.findFirst({
    columns: { visiting_card_path: true },
    where: and(eq(leads.id, leadId), isAdmin(actor) ? undefined : eq(leads.assigned_agent_id, actor.id)),
  });
  if (!lead?.visiting_card_path) return null;
  return ctx.cards.get(lead.visiting_card_path);
}
