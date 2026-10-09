import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "./schema";

// The D1 database for the current request. Only src/server/data may import
// this: it has no notion of who is signed in, so every query must go through
// a data function that applies the caller's access rules.
export async function getDb() {
  const { env } = await getCloudflareContext({ async: true });
  return drizzle(env.DB, { schema });
}

export type Db = Awaited<ReturnType<typeof getDb>>;
export { schema };
