import { getSession } from "@/lib/auth";
import { cardForLead } from "@/server/data/cards";

// A lead's visiting card for someone who can see the lead: the small
// compressed copy from D1, or the full photo from the private bucket with
// ?full=1 (or when no compressed copy exists). Everyone else gets a plain 404.
export async function GET(request: Request, { params }: RouteContext<"/leads/[id]/card">) {
  const id = Number((await params).id);
  const session = await getSession();
  if (!session || !Number.isInteger(id) || id <= 0) return new Response("Not found", { status: 404 });

  const full = new URL(request.url).searchParams.get("full") === "1";
  const card = await cardForLead(session.ctx, session.actor, id, { full });
  if (!card) return new Response("Not found", { status: 404 });
  return new Response(card.body, {
    headers: {
      "Content-Type": card.contentType,
      // The URL carries the card's id (?v=), so a replaced card is a new URL.
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
