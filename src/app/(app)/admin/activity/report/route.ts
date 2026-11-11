import { getSession } from "@/lib/auth";
import { todayInBusinessTz } from "@/lib/dates";
import { monthlyReportXlsx } from "@/lib/reports/monthly-report";
import { monthlyReport } from "@/server/data/activity";
import { AccessDeniedError, InvalidInputError } from "@/server/data/errors";

// The monthly report download (Team activity page). Route handlers are not
// covered by the admin layout, so this checks the session itself and
// monthlyReport() allows admins only.
export async function GET(request: Request) {
  const headers = { "cache-control": "no-store" };
  const session = await getSession();
  if (!session) return new Response("Sign in again.", { status: 401, headers });
  const month = new URL(request.url).searchParams.get("month") || todayInBusinessTz().slice(0, 7);
  try {
    const report = await monthlyReport(session.ctx, session.actor, month);
    const body = monthlyReportXlsx(report);
    return new Response(body as Uint8Array<ArrayBuffer>, {
      headers: {
        ...headers,
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="capitup-lms-report-${report.month}.xlsx"`,
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) return new Response(error.message, { status: 403, headers });
    if (error instanceof InvalidInputError) return new Response(error.message, { status: 400, headers });
    throw error;
  }
}
