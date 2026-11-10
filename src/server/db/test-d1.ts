import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { getPlatformProxy } from "wrangler";

const MIGRATIONS = path.join(process.cwd(), "migrations");

/** Migration file names in the order wrangler applies them. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Runs one migration file, statement by statement. */
export async function applyMigration(db: D1Database, file: string) {
  const statements = readFileSync(path.join(MIGRATIONS, file), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await db.prepare(statement).run();
}

// A fresh, in-memory D1 (the same SQLite build as production, run by
// workerd) with every migration in migrations/ applied (or those before
// `stopBefore`), and an empty R2 bucket. For tests only.
export async function freshD1(opts: { stopBefore?: string } = {}) {
  const proxy = await getPlatformProxy<CloudflareEnv>({ persist: false });
  const db = proxy.env.DB;
  for (const file of migrationFiles()) {
    if (opts.stopBefore && file >= opts.stopBefore) break;
    await applyMigration(db, file);
  }
  return { db, cards: proxy.env.CARDS, dispose: () => proxy.dispose() };
}
