import { getSession } from "@/lib/auth";
import { cardForLead } from "@/server/data/cards";

// A lead's visiting card photo, from the private bucket, for someone who can
// see the lead. Everyone else gets a plain 404.
export async function GET(_request: Request, { params }: RouteContext<"/leads/[id]/card">) {
  const id = Number((await params).id);
  const session = await getSession();
  if (!session || !Number.isInteger(id) || id <= 0) return new Response("Not found", { status: 404 });

  const card = await cardForLead(session.ctx, session.actor, id);
  if (!card) return new Response("Not found", { status: 404 });
  return new Response(card.body, {
    headers: {
      "Content-Type": card.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "private, max-age=600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
