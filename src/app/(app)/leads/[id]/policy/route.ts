import { getSession } from "@/lib/auth";
import { policyDocument } from "@/server/data/transactions";

// The policy copy attached to one of a lead's transactions (?t=<transaction
// id>), for someone who can see the lead. Everyone else gets a plain 404.
export async function GET(request: Request) {
  const session = await getSession();
  const id = Number(new URL(request.url).searchParams.get("t"));
  if (!session || !Number.isInteger(id) || id <= 0) return new Response("Not found", { status: 404 });

  const doc = await policyDocument(session.ctx, session.actor, id);
  if (!doc) return new Response("Not found", { status: 404 });
  const ascii = doc.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new Response(doc.body, {
    headers: {
      "Content-Type": doc.contentType,
      "Content-Disposition": `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // Images get the same lock-down as visiting cards; a sandbox would stop
      // the browser's PDF viewer, so PDFs (checked to be PDFs on upload) get none.
      ...(doc.contentType === "application/pdf" ? {} : { "Content-Security-Policy": "default-src 'none'; sandbox" }),
    },
  });
}
