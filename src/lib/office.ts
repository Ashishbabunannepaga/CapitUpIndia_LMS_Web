import "server-only";

import { requireSession } from "@/lib/auth";
import * as office from "@/server/data/office";
import { officePortal } from "@/server/office/portal";

export type { OfficeOverview, CallRequestPage, CallRequestDetail, OfficeReport, OfficePolicyDetail, OfficeHandoff } from "@/server/data/office";
export type { OfficeLead, OfficeRenewal, OfficePolicy, OfficeGame, OfficePage, GapCounts } from "@/server/office/portal";
export { OFFICE_LEAD_STATUSES, OFFICE_RENEWAL_STATUSES } from "@/server/data/office";

export async function getOfficeOverview() {
  const { actor } = await requireSession();
  return office.officeOverview(officePortal, actor);
}

export async function getCallRequests(cursor?: string | null) {
  const { ctx, actor } = await requireSession();
  return office.listCallRequests(officePortal, ctx, actor, cursor);
}

export async function getCallRequest(id: string) {
  const { ctx, actor } = await requireSession();
  return office.getCallRequest(officePortal, ctx, actor, id);
}

export async function getOfficeRenewals() {
  const { actor } = await requireSession();
  return office.listOfficeRenewals(officePortal, actor);
}

export async function getOfficePolicies(cursor?: string | null) {
  const { actor } = await requireSession();
  return office.listOfficePolicies(officePortal, actor, cursor);
}

export async function getOfficePolicy(id: string) {
  const { actor } = await requireSession();
  return office.getOfficePolicy(officePortal, actor, id);
}

export async function getOfficeReport(conversationId: string) {
  const { actor } = await requireSession();
  return office.getOfficeReport(officePortal, actor, conversationId);
}

export async function getOfficeGames(cursor?: string | null) {
  const { actor } = await requireSession();
  return office.listOfficeGames(officePortal, actor, cursor);
}
