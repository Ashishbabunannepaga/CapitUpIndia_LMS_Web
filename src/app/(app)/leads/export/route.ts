import { getSession } from "@/lib/auth";
import { todayInBusinessTz } from "@/lib/dates";
import { parseLeadFilters } from "@/lib/lead-filters";
import { selectedLeadsXlsx } from "@/lib/reports/renewal-report";
import { AccessDeniedError, InvalidInputError } from "@/server/data/errors";
import { leadsForExport, leadsForFilteredExport } from "@/server/data/leads";

// Leads as an Excel sheet, admins only (the data functions check):
//   ?ids=1,2,3   the leads ticked in the table ("Export selected");
//   otherwise    every lead matching the leads screen's filters (status,
//                product, closed outcome, policy start date range...), as the
//                Export button next to the filters sends them.
export async function GET(request: Request) {
  const headers = { "cache-control": "no-store" };
  const session = await getSession();
  if (!session) return new Response("Sign in again.", { status: 401, headers });
  const params = new URL(request.url).searchParams;
  try {
    let leads;
    let truncated = false;
    if (params.has("ids")) {
      const ids = (params.get("ids") ?? "")
        .split(",")
        .filter((v) => /^\d{1,12}$/.test(v))
        .map(Number);
      leads = await leadsForExport(session.ctx, session.actor, ids);
    } else {
      ({ leads, truncated } = await leadsForFilteredExport(session.ctx, session.actor, parseLeadFilters(Object.fromEntries(params))));
    }
    return new Response(selectedLeadsXlsx(leads) as Uint8Array<ArrayBuffer>, {
      headers: {
        ...headers,
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="capitup-leads-${todayInBusinessTz()}.xlsx"`,
        ...(truncated ? { "x-export-truncated": "1" } : {}),
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) return new Response(error.message, { status: 403, headers });
    if (error instanceof InvalidInputError) return new Response(error.message, { status: 400, headers });
    throw error;
  }
}
