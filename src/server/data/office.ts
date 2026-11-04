import "server-only";

import type { OfficeRenewal, OfficeSource, OfficeStats } from "../office/portal";
import { assertAdmin, isAdmin, type Actor } from "./actor";

// The capitupindia.com/office portal inside the LMS. Everyone signed in gets
// the link and the portal's counts (no client details). The renewal list
// names clients and their phone numbers, so only admins receive it, the same
// rule as the LMS's own all-leads views.

export type OfficeOverview = {
  portalUrl: string;
  state: "ok" | "not-configured" | "error";
  message?: string;
  fetchedAt?: string;
  stats?: OfficeStats;
  /** Admins only; undefined for agents. */
  renewals?: OfficeRenewal[];
};

export async function officeOverview(source: OfficeSource, actor: Actor): Promise<OfficeOverview> {
  const result = await source.read(false);
  const base = { portalUrl: source.portalUrl };
  if (result.status !== "ok") {
    return { ...base, state: result.status, message: result.status === "error" ? result.message : undefined };
  }
  const { stats, renewals, fetchedAt } = result.snapshot;
  return { ...base, state: "ok", fetchedAt, stats, renewals: isAdmin(actor) ? renewals : undefined };
}

/** Admins can fetch a fresh copy now instead of waiting for the cache. */
export async function refreshOffice(source: OfficeSource, actor: Actor): Promise<void> {
  assertAdmin(actor);
  await source.read(true);
}
