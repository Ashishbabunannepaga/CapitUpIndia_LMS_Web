import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { createAuth, type Auth } from "../auth";
import * as schema from "../db/schema";

/** What every data function needs: the database and the auth instance. */
export type DataContext = { db: DrizzleD1Database<typeof schema>; auth: Auth };

export function createDataContext(d1: D1Database, env: Parameters<typeof createAuth>[1]): DataContext {
  return { db: drizzle(d1, { schema }), auth: createAuth(d1, env) };
}

/** The data context for the current request's Worker environment. */
export async function getDataContext(): Promise<DataContext> {
  const { env } = await getCloudflareContext({ async: true });
  return createDataContext(env.DB, env);
}
