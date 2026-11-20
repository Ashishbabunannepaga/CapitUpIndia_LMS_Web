#!/usr/bin/env node
// Refuses migrations that rebuild or drop a table other tables depend on.
//
// On D1 a table rebuild (drizzle-kit's "__new_<table>" copy, then DROP TABLE)
// runs with foreign keys enforced, so dropping `leads` cascades and deletes
// every event, note, tag and transaction. Production applies migrations on
// every deploy, so this check runs in CI before anything can reach main.
//
// A rebuild that has been checked by hand (a dry run on a copy of live D1)
// can be allowed with a line in the migration:
//   -- allow-table-rebuild: <table> (<why it is safe>)
//
//   node scripts/check-migrations.mjs [migrations-dir]

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Tables with rows in other tables that point at them (ON DELETE CASCADE or SET NULL). */
export const PROTECTED_TABLES = [
  "user",
  "profiles",
  "leads",
  "events",
  "lead_notes",
  "lead_note_reads",
  "lead_tags",
  "lead_transactions",
  "lead_contact_logs",
  "notifications",
  "push_subscriptions",
  "visiting_card_previews",
];

const quoted = (table) => `[\`"]?${table}[\`"]?`;

/** Problems in one migration's SQL: a list of messages, empty when it is safe. */
export function migrationProblems(name, text) {
  const problems = [];
  const allowed = new Set([...text.matchAll(/--\s*allow-table-rebuild:\s*([a-z_]+)/gi)].map((m) => m[1].toLowerCase()));
  for (const table of PROTECTED_TABLES) {
    if (allowed.has(table)) continue;
    const patterns = [
      [new RegExp(`DROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?${quoted(table)}\\s*;`, "i"), "drops"],
      [new RegExp(`[\`"]?__new_${table}[\`"]?`, "i"), "rebuilds"],
      [new RegExp(`ALTER\\s+TABLE\\s+${quoted(table)}\\s+RENAME\\s+TO`, "i"), "renames"],
    ];
    for (const [pattern, verb] of patterns) {
      if (pattern.test(text)) {
        problems.push(
          `${name} ${verb} \`${table}\`. On D1 that deletes the rows that point at it (events, notes...). ` +
            "Use ADD COLUMN / a new table instead, or add '-- allow-table-rebuild: " +
            `${table} (reason)' after a dry run on a copy of live D1.`,
        );
        break;
      }
    }
  }
  return problems;
}

function main() {
  const dir = process.argv[2] ?? "migrations";
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const problems = files.flatMap((file) => migrationProblems(file, readFileSync(join(dir, file), "utf8")));
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
  }
  console.log(`Checked ${files.length} migrations: no table rebuilds or drops of protected tables.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
