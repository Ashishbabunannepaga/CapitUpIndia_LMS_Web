import assert from "node:assert/strict";
import { test } from "node:test";

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
