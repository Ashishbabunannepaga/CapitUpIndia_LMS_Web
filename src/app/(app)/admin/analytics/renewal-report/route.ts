import { getSession } from "@/lib/auth";
import { renewalReportXlsx } from "@/lib/reports/renewal-report";
import { renewalPipeline } from "@/server/data/analytics";
import { AccessDeniedError } from "@/server/data/errors";

// "Download renewal report" on Analytics: leads renewing in the next 30/60/90
// days by agent and product. Route handlers are not covered by the admin
// layout, so this checks the session itself; renewalPipeline() is admin-only.
export async function GET() {
  const headers = { "cache-control": "no-store" };
  const session = await getSession();
  if (!session) return new Response("Sign in again.", { status: 401, headers });
  try {
    const { today, rows } = await renewalPipeline(session.ctx, session.actor);
    return new Response(renewalReportXlsx(today, rows) as Uint8Array<ArrayBuffer>, {
      headers: {
        ...headers,
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="capitup-renewals-${today}.xlsx"`,
      },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) return new Response(error.message, { status: 403, headers });
    throw error;
  }
}
