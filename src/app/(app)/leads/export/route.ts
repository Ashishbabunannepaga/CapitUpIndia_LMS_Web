import { getSession } from "@/lib/auth";
import { todayInBusinessTz } from "@/lib/dates";
import { selectedLeadsXlsx } from "@/lib/reports/renewal-report";
import { AccessDeniedError, InvalidInputError } from "@/server/data/errors";
import { leadsForExport } from "@/server/data/leads";

// "Export selected" in the leads table: the ticked leads as an Excel sheet.
// Admins only (leadsForExport checks); ids come as ?ids=1,2,3.
export async function GET(request: Request) {
  const headers = { "cache-control": "no-store" };
  const session = await getSession();
  if (!session) return new Response("Sign in again.", { status: 401, headers });
  const ids = (new URL(request.url).searchParams.get("ids") ?? "")
    .split(",")
    .filter((v) => /^\d{1,12}$/.test(v))
    .map(Number);
  try {
    const leads = await leadsForExport(session.ctx, session.actor, ids);
    return new Response(selectedLeadsXlsx(leads) as Uint8Array<ArrayBuffer>, {
      headers: {
        ...headers,
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="capitup-leads-${todayInBusinessTz()}.xlsx"`,
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) return new Response(error.message, { status: 403, headers });
    if (error instanceof InvalidInputError) return new Response(error.message, { status: 400, headers });
    throw error;
  }
}
