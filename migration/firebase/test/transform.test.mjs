import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCheckSql, buildImportSql } from "../sql.mjs";
import { normalizeCompanyName, parseAppDate, parseNoteTimestamp, transform } from "../transform.mjs";

const lead = (over) => ({ id: 1, clientName: "Acme", status: "Prospect", policyProduct: "Health", createdAt: 1790000000000, ...over });

test("company names normalize like the database", () => {
  assert.equal(normalizeCompanyName("Renee Systems Pvt. Ltd."), "renee systems");
  assert.equal(normalizeCompanyName("A & B Corp"), "a and b");
  assert.equal(normalizeCompanyName("Ltd"), "ltd");
});

test("dates in the app's and hand-typed formats", () => {
  assert.deepEqual(parseAppDate("2027-01-05"), { date: "2027-01-05", time: null });
  assert.deepEqual(parseAppDate("2027-01-05 09:30"), { date: "2027-01-05", time: "09:30" });
  assert.deepEqual(parseAppDate("05/01/2027"), { date: "2027-01-05", time: null });
  assert.equal(parseAppDate("2027-02-30"), null);
  assert.equal(parseAppDate("next week"), null);
  assert.equal(parseNoteTimestamp("02 Oct 2026, 14:05"), "2026-10-02 14:05:00+05:30");
  assert.equal(parseNoteTimestamp("2 October 2026 9:05"), "2026-10-02 09:05:00+05:30");
});

test("old statuses map to the six decided ones", () => {
  const statuses = ["Pending", "Contacted", "Converted", "Active Client", "Closed Lost", "Quoted"];
  const { imported } = transform({ leads: statuses.map((status, i) => lead({ id: i + 1, clientName: `C${i}`, status })) });
  assert.deepEqual(
    imported.map((l) => l.status),
    ["Follow-up", "Follow-up", "Closed Won", "Active Client", "Closed Lost", "Quoted"],
  );
});

test("type falls back to Renewal only when a renewal date exists", () => {
  const { imported } = transform({
    leads: { a: lead({ id: "a", type: "", renewalDate: "2027-01-01" }), b: lead({ id: "b", clientName: "B", type: "" }) },
  });
  assert.deepEqual(imported.map((l) => l.type), ["Renewal", "New"]);
  assert.deepEqual(imported.map((l) => l.flags.length), [0, 0]);
});

test("explicit designations are kept", () => {
  const { imported } = transform({ leads: [lead({ pocName: "Rajesh", pocDesignation: "Director" })] });
  assert.equal(imported[0].pocDesignation, "Director");
});

test("unparseable note lines stay in the free-text notes", () => {
  const { imported } = transform({
    leads: [lead({ notes: "[Amit - someday]: hello\n[Amit - 01 Jan 2026, 10:00]: real note\nplain" })],
  });
  assert.equal(imported[0].leadNotes.length, 1);
  assert.equal(imported[0].notes, "[Amit - someday]: hello\nplain");
});

test("only user names are read from /users", () => {
  const { agents } = transform({ leads: [], userNames: ["Neha"] });
  assert.deepEqual(agents.map((a) => a.name), ["Neha"]);
  assert.equal(JSON.stringify(transform({ leads: [], userNames: ["Neha"] })).includes("password"), false);
});

test("spreadsheet header rows are skipped", () => {
  const { imported, skipped } = transform({ leads: [lead({ clientName: "client_name", pocName: "business_type" })] });
  assert.equal(imported.length, 0);
  assert.match(skipped[0].reason, /header row/);
});

test("agent names use the spelling from leads, not the login", () => {
  const { agents } = transform({
    leads: [
      lead({ assignedAgent: "sravani" }),
      lead({ id: 2, clientName: "B", assignedAgent: "Sravani" }),
      lead({ id: 3, clientName: "C", assignedAgent: "Sravani" }),
    ],
    userNames: ["sravani"],
  });
  assert.deepEqual(agents.map((a) => [a.name, a.leads]), [["Sravani", 3]]);
});

test("records that differ in any field are both kept", () => {
  const base = { clientName: "Acme Pvt Ltd", pocName: "Ravi", pocDesignation: "poc", poc2EmailId: "" };
  const { imported, skipped } = transform({
    leads: [
      lead({ id: 1, ...base }),
      lead({ id: 2, ...base, clientName: "Acme Pvt. Ltd" }),
      lead({ id: 3, ...base, pocDesignation: "Director" }),
      lead({ id: 4, ...base, poc2EmailId: "b@acme.example" }),
    ],
  });
  assert.deepEqual(imported.map((l) => l.legacyId), ["1", "3", "4"]);
  assert.deepEqual(skipped.map((s) => s.reason), [`Copy of record 1, which writes the company name as "Acme Pvt Ltd"`]);
});

test("the old calendar fills a blanked renewal date and keeps an overwritten client", () => {
  const due = (id, leadId, title, date) => [id, { id, leadId, title, date, isSystemGenerated: true, isBackgroundReminder: false, notes: "POC: X" }];
  const { imported, calendarMismatches } = transform({
    leads: [
      lead({ id: 1, clientName: "Jan First Ltd", renewalDate: "" }),
      lead({ id: 2, clientName: "Chiranjeevi" }),
      lead({ id: 3, clientName: "Split Dates", renewalDate: "" }),
    ],
    events: Object.fromEntries([
      due("a", 1, "Renewal due: Jan First Ltd (Health)", "2027-01-01"),
      due("b", 2, "Renewal due: Awaze pvt Ltd (Health)", "2026-08-07"),
      due("c", 3, "Renewal due: Split Dates (Health)", "2027-01-01"),
      due("d", 3, "Renewal due: Split Dates (Health)", "2027-02-01"),
      due("e", 1, "Task due: Jan First Ltd (Health)", "2026-12-31"),
    ]),
  });
  assert.equal(imported[0].renewalDate, "2027-01-01");
  assert.match(imported[1].notes, /Old calendar entry for this record: "Renewal due: Awaze pvt Ltd \(Health\)" on 2026-08-07 \(POC: X\)/);
  assert.equal(imported[2].renewalDate, null, "conflicting calendar dates are not guessed");
  assert.deepEqual(calendarMismatches.map((c) => c.calendarClient), ["Awaze pvt Ltd"]);
});

// What the database would execute: the SQL with comments and quoted literals removed.
function executable(sql) {
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith("--", i)) {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
    } else if (sql[i] === "'") {
      for (i++; i < sql.length; i++) {
        if (sql[i] === "'" && sql[i + 1] === "'") i++;
        else if (sql[i] === "'") break;
      }
      out += "''";
    } else {
      out += sql[i];
    }
  }
  return out;
}

test("text from the export never becomes executable SQL", () => {
  const evil = "9\n\\! touch pwned\ndrop table public.leads; -- select 1\r";
  const result = transform({ leads: [lead({ id: evil, clientName: "Evil $firebase_import$", assignedAgent: "D'Souza\ndrop table x;" })] });
  const meta = { sourceLabel: "export.json\ndrop table public.leads;", generatedAt: "2026-10-06T00:00:00Z\n\\! touch pwned" };
  for (const sql of [buildImportSql(result, meta), buildCheckSql(result, meta)]) {
    const code = executable(sql);
    assert.doesNotMatch(code, /drop table|\\!|pwned/i);
  }
  const sql = buildImportSql(result, meta);
  assert.match(sql, /^do \$firebase_import_\$$/m, "the dollar-quote tag avoids text in the data");
  assert.match(sql, /^-- legacy "9\\n\\\\! touch pwned\\ndrop table public\.leads; -- select 1"$/m);
});
