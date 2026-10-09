import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { getPlatformProxy } from "wrangler";

// A fresh, in-memory D1 (the same SQLite build as production, run by
// workerd) with every migration in migrations/ applied, and an empty R2
// bucket. For tests only.
export async function freshD1() {
  const proxy = await getPlatformProxy<CloudflareEnv>({ persist: false });
  const db = proxy.env.DB;
  const dir = path.join(process.cwd(), "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const statements = readFileSync(path.join(dir, file), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) await db.prepare(statement).run();
  }
  return { db, cards: proxy.env.CARDS, dispose: () => proxy.dispose() };
}
