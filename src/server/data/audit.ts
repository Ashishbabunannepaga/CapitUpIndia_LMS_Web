import "server-only";

import type { SQL } from "drizzle-orm";

import { auditLogs } from "../db/schema";
import type { Actor } from "./actor";
import type { DataContext } from "./context";

// Audit rows, written in the same D1 batch as the change they describe (the
// write_audit_log() trigger did this in Postgres, where it knew the user).

type Row = Record<string, unknown> | null;

export function auditInsert(
  ctx: DataContext,
  actor: Pick<Actor, "id"> | null,
  table: string,
  recordId: string | number | SQL,
  action: "INSERT" | "UPDATE" | "DELETE",
  oldData: Row,
  newData: Row,
) {
  return ctx.db.insert(auditLogs).values({
    table_name: table,
    record_id: typeof recordId === "object" ? recordId : String(recordId),
    action,
    actor_id: actor?.id ?? null,
    old_data: oldData,
    new_data: newData,
  });
}

/** True when the rows differ in anything but updated_at. */
export function changed(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return Object.keys({ ...before, ...after }).some((k) => k !== "updated_at" && before[k] !== after[k]);
}
