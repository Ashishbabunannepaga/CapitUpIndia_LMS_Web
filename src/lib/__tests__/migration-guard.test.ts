import { describe, expect, it } from "vitest";

import { migrationProblems } from "../../../scripts/check-migrations.mjs";

// The CI guard that stops a migration from rebuilding `leads` (and so
// deleting every event and note through ON DELETE CASCADE on D1).
describe("migration guard", () => {
  it("allows ADD COLUMN and new tables", () => {
    expect(migrationProblems("0013.sql", "ALTER TABLE `leads` ADD `lead_source` text;\nCREATE TABLE `x` (`id` integer);")).toEqual([]);
  });

  it("refuses a drizzle-kit rebuild of leads", () => {
    const sql = "CREATE TABLE `__new_leads` (...);\nINSERT INTO `__new_leads` SELECT * FROM `leads`;\nDROP TABLE `leads`;\nALTER TABLE `__new_leads` RENAME TO `leads`;";
    const problems = migrationProblems("0013.sql", sql);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/leads/);
  });

  it("refuses dropping events or lead_notes", () => {
    expect(migrationProblems("a.sql", "DROP TABLE IF EXISTS `events`;")).toHaveLength(1);
    expect(migrationProblems("b.sql", 'DROP TABLE "lead_notes";')).toHaveLength(1);
  });

  it("allows rebuilding a table nothing depends on", () => {
    expect(migrationProblems("c.sql", "CREATE TABLE `__new_ai_usage_logs` (...);\nDROP TABLE `ai_usage_logs`;")).toEqual([]);
  });

  it("lets a checked rebuild through with an explicit allow line", () => {
    expect(migrationProblems("d.sql", "-- allow-table-rebuild: events (dry run on a copy, 2026-11-20)\nDROP TABLE `events`;")).toEqual([]);
  });

  it("does not confuse lead_notes with leads", () => {
    expect(migrationProblems("e.sql", "-- allow-table-rebuild: lead_notes (checked)\nDROP TABLE `lead_notes`;")).toEqual([]);
  });
});
