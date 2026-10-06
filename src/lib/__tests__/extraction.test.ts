import { describe, expect, it } from "vitest";

import { heuristicParseText } from "@/lib/ai/heuristics";
import { cleanExtractedLead, cleanPhones, normalizeProduct, splitNameAndDesignation } from "@/lib/ai/lead-cleanup";
import { normalizeCompanyName } from "@/lib/company-name";
import { parseLooseDate } from "@/lib/date-parse";
import { heuristicMapRow, parsePastedSheet } from "@/lib/import/sheet";

// The rules that decide what AI output becomes, independent of any model.

const TODAY = "2026-10-05";

describe("parseLooseDate", () => {
  it("reads the date formats found in agent notes and insurance sheets", () => {
    expect(parseLooseDate("renewal 2026-11-15", TODAY)).toBe("2026-11-15");
    expect(parseLooseDate("09-05-2023", TODAY)).toBe("2023-05-09");
    expect(parseLooseDate("15/11/26", TODAY)).toBe("2026-11-15");
    expect(parseLooseDate("23 rd Feb Renewal", TODAY)).toBe("2027-02-23");
    expect(parseLooseDate("20-Apr", TODAY)).toBe("2027-04-20");
    expect(parseLooseDate("Nov-03", TODAY)).toBe("2026-11-03");
    expect(parseLooseDate("October 2026", TODAY)).toBe("2026-10-01");
    expect(parseLooseDate("may renewal", TODAY)).toBe("2027-05-01");
  });

  it("rolls a bare month to its next occurrence", () => {
    // October is the current month, so it stays in this year; September has passed.
    expect(parseLooseDate("October renewal", TODAY)).toBe("2026-10-01");
    expect(parseLooseDate("sep renewal", TODAY)).toBe("2027-09-01");
  });

  it("returns null rather than inventing a date", () => {
    expect(parseLooseDate("", TODAY)).toBeNull();
    expect(parseLooseDate("they may renew later", TODAY)).toBeNull();
    expect(parseLooseDate("31-02-2026", TODAY)).toBeNull();
    expect(parseLooseDate("call 9845012345", TODAY)).toBeNull();
  });
});

describe("normalizeCompanyName", () => {
  it("matches the database's normalization", () => {
    expect(normalizeCompanyName("Renee Systems India Pvt. Ltd.")).toBe("renee systems india");
    expect(normalizeCompanyName("  RENEE   systems  ")).toBe("renee systems");
    expect(normalizeCompanyName("A & B Corp")).toBe("a and b");
  });
});

describe("normalizeProduct", () => {
  it("maps sheet wording to the eight products", () => {
    expect(normalizeProduct("Group health insurance")).toBe("Health");
    expect(normalizeProduct("WC")).toBe("Liability");
    expect(normalizeProduct("Package policy")).toBe("Fire or Property");
    expect(normalizeProduct("Cargo transit")).toBe("Marine");
    expect(normalizeProduct("Travel cover")).toBe("Travel");
    expect(normalizeProduct("")).toBe("Health");
  });
});

describe("splitNameAndDesignation", () => {
  it("keeps explicit designations and strips extra names", () => {
    expect(splitNameAndDesignation("Rajesh ( HR )")).toEqual({ name: "Rajesh", designation: "HR" });
    expect(splitNameAndDesignation("Rajesh (Director)")).toEqual({ name: "Rajesh", designation: "Director" });
    expect(splitNameAndDesignation("Viresh Kumar ( GM- HR ), mohan")).toEqual({
      name: "Viresh Kumar",
      designation: "GM- HR",
    });
  });
});

describe("cleanPhones", () => {
  it("drops placeholder numbers and numbers not in the source", () => {
    const source = "call Rajesh on 98450 12345";
    expect(cleanPhones("9845012345", { sourceText: source })).toBe("9845012345");
    expect(cleanPhones("+91 98450-12345", { sourceText: source })).toBe("9845012345");
    expect(cleanPhones("9876543210", { sourceText: source })).toBe("");
    expect(cleanPhones("9000000001", { sourceText: source })).toBe("");
  });
});

describe("cleanExtractedLead", () => {
  const source =
    "Met Rajesh (Director) from Renee Systems Pvt Ltd today, 9845012345, rajesh@renee.in. Group health renewal due 15 Nov, 120 lives.";

  it("keeps an explicit designation such as Director", () => {
    const { lead } = cleanExtractedLead(
      {
        client_name: "renee systems pvt ltd",
        type: "Renewal",
        business_type: "Corporate",
        policy_product: "Health",
        renewal_date: "15 Nov",
        poc_name: "Rajesh",
        poc_designation: "Director",
        poc_contact_number: "9845012345",
        poc_email_id: "rajesh@renee.in",
        notes: "120 lives",
      },
      { sourceText: source, today: TODAY },
    );
    expect(lead.poc_designation).toBe("Director");
    expect(lead.client_name).toBe("Renee Systems Pvt Ltd");
    expect(lead.renewal_date).toBe("2026-11-15");
    expect(lead.type).toBe("Renewal");
  });

  it("defaults the designation to poc and reports what it dropped", () => {
    const { lead, dropped } = cleanExtractedLead(
      {
        client_name: "Acme",
        poc_name: "Priya",
        poc_contact_number: "9876543210",
        poc_email_id: "contact@company.com",
        renewal_date: "soon",
      },
      { sourceText: "Priya from Acme wants a quote", today: TODAY },
    );
    expect(lead.poc_designation).toBe("poc");
    expect(lead.poc_contact_number).toBe("");
    expect(lead.poc_email_id).toBe("");
    expect(lead.renewal_date).toBe("");
    expect(lead.type).toBe("New");
    expect(dropped.length).toBeGreaterThanOrEqual(3);
  });

  it("moves a number sitting in the name field into the phone field", () => {
    const { lead } = cleanExtractedLead(
      { client_name: "Acme", poc_name: "9845012345" },
      { sourceText: "Acme 9845012345", today: TODAY },
    );
    expect(lead.poc_name).toBe("");
    expect(lead.poc_contact_number).toBe("9845012345");
  });
});

describe("heuristicParseText", () => {
  it("finds the contact details without AI", () => {
    const raw = heuristicParseText(
      "Met Rajesh (Director) from Renee Systems today, 9845012345, rajesh@renee.in. Renewal 15 Nov.",
      TODAY,
    );
    const { lead } = cleanExtractedLead(raw, { sourceText: "9845012345 rajesh@renee.in Director", today: TODAY });
    expect(lead.poc_name).toBe("Rajesh");
    expect(lead.poc_designation).toBe("Director");
    expect(lead.poc_contact_number).toBe("9845012345");
    expect(lead.poc_email_id).toBe("rajesh@renee.in");
    expect(lead.renewal_date).toBe("2026-11-15");
    expect(lead.type).toBe("Renewal");
  });

  it("invents nothing when the note has no details", () => {
    const { lead } = cleanExtractedLead(heuristicParseText("spoke to someone, call back later", TODAY), {
      sourceText: "spoke to someone, call back later",
      today: TODAY,
    });
    expect(lead.poc_contact_number).toBe("");
    expect(lead.poc_email_id).toBe("");
    expect(lead.renewal_date).toBe("");
  });
});

describe("sheet parsing", () => {
  const pasted = [
    "NAME OF THE CLIENT\tCONTACT DETAILS\tCONTACT PERSON\tDATE OF RENEWAL\tREMARKS",
    "Renee Systems Pvt Ltd\t9845012345\tRajesh (Director)\t15 Nov\tGroup health, 120 lives",
    "Kaveri Textiles\tpriya@kaveri.in\tPriya\t23 rd Feb Renewal\tFire policy",
  ].join("\n");

  it("detects the header and numbers the data rows", () => {
    const sheet = parsePastedSheet(pasted);
    expect(sheet.header[0]).toBe("NAME OF THE CLIENT");
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0].row).toBe(1);
  });

  it("maps a row to lead fields without AI", () => {
    const sheet = parsePastedSheet(pasted);
    const { lead } = cleanExtractedLead(heuristicMapRow(sheet, sheet.rows[0], TODAY), { today: TODAY });
    expect(lead.client_name).toBe("Renee Systems Pvt Ltd");
    expect(lead.poc_name).toBe("Rajesh");
    expect(lead.poc_designation).toBe("Director");
    expect(lead.poc_contact_number).toBe("9845012345");
    expect(lead.renewal_date).toBe("2026-11-15");
    expect(lead.policy_product).toBe("Health");
    expect(lead.type).toBe("Renewal");
  });

  it("handles quoted CSV and a sheet with no header", () => {
    const sheet = parsePastedSheet('"Acme, Inc",9845012345,"Priya",,"wants a quote"');
    expect(sheet.header).toHaveLength(0);
    expect(sheet.rows[0].cells[0]).toBe("Acme, Inc");
  });
});
