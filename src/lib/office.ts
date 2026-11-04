import "server-only";

import { requireSession } from "@/lib/auth";
import { officeOverview, type OfficeOverview } from "@/server/data/office";
import { officePortal } from "@/server/office/portal";

export type { OfficeOverview };

export async function getOfficeOverview(): Promise<OfficeOverview> {
  const { actor } = await requireSession();
  return officeOverview(officePortal, actor);
}
