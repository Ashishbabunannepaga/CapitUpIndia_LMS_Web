import { getSession } from "@/lib/auth";
import { friendlyError } from "@/lib/action-errors";
import { downloadOfficePolicy } from "@/server/data/office";
import { officePortal } from "@/server/office/portal";

// A client's uploaded policy from the office portal, streamed through for
// admins. Everyone else gets a plain 404.
export async function GET(_request: Request, { params }: RouteContext<"/office/policies/[id]/download">) {
  const { id } = await params;
  const session = await getSession();
  if (!session || session.actor.role !== "ADMIN") return new Response("Not found", { status: 404 });

  let file: Response;
  try {
    file = await downloadOfficePolicy(officePortal, session.ctx, session.actor, id);
  } catch (error) {
    return new Response(friendlyError(error), { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const headers = new Headers({
    "Content-Type": file.headers.get("content-type") ?? "application/octet-stream",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  const disposition = file.headers.get("content-disposition");
  headers.set("Content-Disposition", disposition && disposition.startsWith("attachment") ? disposition : "attachment");
  const length = file.headers.get("content-length");
  if (length) headers.set("Content-Length", length);
  return new Response(file.body, { headers });
}
