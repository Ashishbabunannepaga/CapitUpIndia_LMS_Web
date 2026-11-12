import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { createAuth, type Auth } from "../auth";
import * as schema from "../db/schema";

/** What data functions need: the database, auth, and the visiting-card bucket. */
export type DataContext = { db: DrizzleD1Database<typeof schema>; auth: Auth; cards: R2Bucket };

const databases = new WeakMap<D1Database, DataContext["db"]>();

/** The Drizzle wrapper for a D1 binding, reused for the isolate (it is stateless). */
export function databaseFor(d1: D1Database): DataContext["db"] {
  let db = databases.get(d1);
  if (!db) {
    db = drizzle(d1, { schema });
    databases.set(d1, db);
  }
  return db;
}

export function createDataContext(
  d1: D1Database,
  env: Parameters<typeof createAuth>[1],
  cards: R2Bucket,
): DataContext {
  // Reused per binding, like the auth instance: both are stateless wrappers.
  return { db: databaseFor(d1), auth: createAuth(d1, env), cards };
}

/** The data context for the current request's Worker environment. */
export async function getDataContext(): Promise<DataContext> {
  const { env } = await getCloudflareContext({ async: true });
  return createDataContext(env.DB, env, env.CARDS);
}
