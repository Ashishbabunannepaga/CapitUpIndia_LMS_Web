import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { heuristicParseText } from "@/lib/ai/heuristics";
import {
  cleanEmail,
  cleanExtractedLead,
  cleanPhones,
  normalizeBusinessType,
  normalizeProduct,
  splitNameAndDesignation,
  tidyCase,
} from "@/lib/ai/lead-cleanup";
import { normalizeCompanyName } from "@/lib/company-name";

// Messy agent notes, sheets and AI output: what must come out clean, and
// what must never be invented.

const TODAY = "2026-10-05";

describe("normalizeCompanyName", () => {
  // The same fixture is checked against the SQL function in
  // supabase/tests/edge_cases.test.sql, so duplicate grouping in the importer
  // and in the database can never drift apart.
  const fixture = JSON.parse(
    readFileSync(new URL("../../../supabase/tests/fixtures/company_names.json", import.meta.url), "utf8"),
  ) as Record<string, string>;

  it.each(Object.entries(fixture))("%j -> %j", (input, expected) => {
    expect(normalizeCompanyName(input)).toBe(expected);
  });

  it("handles missing names", () => {
    expect(normalizeCompanyName(null)).toBe("");
    expect(normalizeCompanyName(undefined)).toBe("");
  });

  it("groups the spellings agents actually use for one company", () => {
    const spellings = ["Renee Systems Pvt Ltd", "RENEE SYSTEMS PVT. LTD.", "Renee Systems Private Limited", "renee systems"];
    expect(new Set(spellings.map(normalizeCompanyName)).size).toBe(1);
  });
});

describe("normalizeProduct", () => {
  const cases: [string, string][] = [
    ["Fire & Burglary", "Fire or Property"],
    ["Office package", "Fire or Property"],
    ["SFSP", "Fire or Property"],
    ["Group Mediclaim", "Health"],
    ["GMC", "Health"],
    ["health cover for office staff", "Health"],
    ["Shopkeeper policy", "Health"],
    ["shop insurance", "Fire or Property"],
    ["Car insurance", "Motor"],
    ["two wheeler", "Motor"],
    ["Fleet", "Motor"],
    ["D&O", "Liability"],
    ["Cyber", "Liability"],
    ["Workmen compensation", "Liability"],
    ["GTL", "Life"],
    ["Term plan", "Life"],
    ["Marine cargo", "Marine"],
    ["Trade credit", "Credit"],
    ["Overseas travel", "Travel"],
    ["fire or property", "Fire or Property"],
    ["something unknown", "Health"],
  ];
  it.each(cases)("%s -> %s", (input, product) => {
    expect(normalizeProduct(input)).toBe(product);
  });

  it("defaults to Health for empty input", () => {
    expect(normalizeProduct(null)).toBe("Health");
    expect(normalizeProduct(undefined)).toBe("Health");
  });
});

describe("normalizeBusinessType", () => {
  it("uses the explicit value, then hints in the context", () => {
    expect(normalizeBusinessType("Retail")).toBe("Retail");
    expect(normalizeBusinessType("CORPORATE", "family floater")).toBe("Corporate");
    expect(normalizeBusinessType("", "family floater for Mr Rao")).toBe("Retail");
    expect(normalizeBusinessType("", "car insurance")).toBe("Retail");
    expect(normalizeBusinessType("", "group health for 120 staff")).toBe("Corporate");
    expect(normalizeBusinessType(null)).toBe("Corporate");
  });
});

describe("splitNameAndDesignation", () => {
  const cases: [string, string, string][] = [
    ["Rajesh ( HR )", "Rajesh", "HR"],
    ["Rajesh [CFO]", "Rajesh", "CFO"],
    ["Dr. S. Rao (MD)", "Dr. S. Rao", "MD"],
    ["Rajesh Kumar - HR Head", "Rajesh Kumar", "HR Head"],
    ["Rajesh Kumar – Director", "Rajesh Kumar", "Director"],
    ["Jean-Paul Mehta", "Jean-Paul Mehta", ""],
    ["Priya - 9845012345", "Priya - 9845012345", ""],
    ["Priya / Anil", "Priya", ""],
    ["Ram & Shyam", "Ram", ""],
    ["Priya or Anil", "Priya", ""],
    ['"Priya",', "Priya", ""],
    ["", "", ""],
  ];
  it.each(cases)("%j -> %j / %j", (raw, name, designation) => {
    expect(splitNameAndDesignation(raw)).toEqual({ name, designation });
  });
});

describe("tidyCase", () => {
  const cases: [string, string][] = [
    ["sharma's textiles", "Sharma's Textiles"],
    ["mcdonald's", "Mcdonald's"],
    ["o'brien & co", "O'Brien & Co"],
    ["abc pvt ltd", "Abc Pvt Ltd"],
    ["bank of baroda", "Bank of Baroda"],
    ["the oberoi group", "The Oberoi Group"],
    ["ACME india", "ACME India"],
    ["iPhone Store", "IPhone Store"],
    ["3m india", "3m India"],
    ["", ""],
  ];
  it.each(cases)("%j -> %j", (input, expected) => {
    expect(tidyCase(input)).toBe(expected);
  });
});

describe("cleanPhones", () => {
  it("keeps real numbers as canonical digits", () => {
    expect(cleanPhones("+91-98450 12345 / 080-41234567", {})).toBe("9845012345, 8041234567");
    expect(cleanPhones("09845012345", {})).toBe("9845012345");
    expect(cleanPhones("+91 9845012345, 9845012345", {})).toBe("9845012345");
  });

  it("drops placeholders and anything too short or too long", () => {
    const dropped: string[] = [];
    expect(cleanPhones("1111111111", {}, dropped)).toBe("");
    expect(cleanPhones("9999999999", {}, dropped)).toBe("");
    expect(dropped).toHaveLength(2);
    expect(cleanPhones("12345", {})).toBe("");
    expect(cleanPhones("98450123459845012345", {})).toBe("");
    expect(cleanPhones("", {})).toBe("");
  });

  it("drops numbers the AI made up", () => {
    const dropped: string[] = [];
    expect(cleanPhones("9845012345, 9845099999", { sourceText: "ph 98450-12345" }, dropped)).toBe("9845012345");
    expect(dropped).toEqual(["number 9845099999 (not in your text)"]);
  });

  it("never exceeds the 32-character column", () => {
    const many = "9845012341, 9845012342, 9845012343, 9845012344";
    const out = cleanPhones(many, {});
    expect(out.length).toBeLessThanOrEqual(32);
    expect(out).toBe("9845012341, 9845012342");
  });
});

describe("cleanEmail", () => {
  it("normalizes and validates", () => {
    expect(cleanEmail("Rajesh.Kumar@Renee.IN.", {})).toBe("rajesh.kumar@renee.in");
    expect(cleanEmail("mailto:a@b.co", {})).toBe("a@b.co");
    expect(cleanEmail("Email: priya@kaveri.in; alt anil@kaveri.in", {})).toBe("priya@kaveri.in");
    expect(cleanEmail("a@b", {})).toBe("");
    expect(cleanEmail("", {})).toBe("");
  });

  it("drops placeholders and emails missing from the source", () => {
    const dropped: string[] = [];
    expect(cleanEmail("test@test.com", {}, dropped)).toBe("");
    expect(cleanEmail("someone@example.com", {}, dropped)).toBe("");
    expect(cleanEmail("priya@kaveri.in", { sourceText: "call Priya" }, dropped)).toBe("");
    expect(cleanEmail("priya@kaveri.in", { sourceText: "PRIYA@KAVERI.IN" })).toBe("priya@kaveri.in");
    expect(dropped).toHaveLength(3);
  });
});

describe("cleanExtractedLead", () => {
  it("accepts any garbage the model returns without throwing", () => {
    const { lead } = cleanExtractedLead(
      { client_name: 42, poc_name: null, renewal_date: { y: 2026 }, notes: ["a", "b"], type: undefined },
      { today: TODAY },
    );
    expect(lead.client_name).toBe("42");
    expect(lead.poc_name).toBe("");
    expect(lead.renewal_date).toBe("");
    expect(lead.type).toBe("New");
  });

  it("caps every field at its database length", () => {
    const { lead } = cleanExtractedLead(
      { client_name: "x".repeat(400), poc_name: "y".repeat(200), notes: "z".repeat(25000), address: "a".repeat(2000) },
      { today: TODAY },
    );
    expect(lead.client_name).toHaveLength(300);
    expect(lead.poc_name).toHaveLength(120);
    expect(lead.notes).toHaveLength(20000);
    expect(lead.address).toHaveLength(1000);
  });

  it("drops a designation the source never states", () => {
    const { lead, dropped } = cleanExtractedLead(
      { client_name: "Acme", poc_name: "Priya", poc_designation: "CEO" },
      { sourceText: "Priya from Acme", today: TODAY },
    );
    expect(lead.poc_designation).toBe("poc");
    expect(dropped).toContain('designation "CEO" (not in your text)');
  });

  it("leaves the second contact empty when there is none", () => {
    const { lead } = cleanExtractedLead({ client_name: "Acme", poc_name: "Priya" }, { today: TODAY });
    expect(lead.poc2_name).toBe("");
    expect(lead.poc2_designation).toBe("");
  });

  it("keeps a valid ISO renewal date and reports an impossible one", () => {
    expect(cleanExtractedLead({ renewal_date: "2027-02-28" }, { today: TODAY }).lead.renewal_date).toBe("2027-02-28");
    const { lead, dropped } = cleanExtractedLead({ renewal_date: "2027-02-30" }, { today: TODAY });
    expect(lead.renewal_date).toBe("");
    expect(dropped).toContain('renewal date "2027-02-30" (not a real date)');
  });

  it("strips quotes around a company name and tidies its case", () => {
    expect(cleanExtractedLead({ client_name: '"sharma\'s textiles"' }, { today: TODAY }).lead.client_name).toBe(
      "Sharma's Textiles",
    );
  });
});

describe("heuristicParseText", () => {
  it("reads a labelled note", () => {
    const text = "Client: Kaveri Textiles, POC Priya Sharma (HR) priya@kaveri.in +91 98450 12345, motor fleet renewal 3rd March";
    const { lead } = cleanExtractedLead(heuristicParseText(text, TODAY), { sourceText: text, today: TODAY });
    expect(lead.client_name).toBe("Kaveri Textiles");
    expect(lead.poc_name).toBe("Priya Sharma");
    expect(lead.poc_designation).toBe("HR");
    expect(lead.poc_email_id).toBe("priya@kaveri.in");
    expect(lead.poc_contact_number).toBe("9845012345");
    expect(lead.policy_product).toBe("Motor");
    expect(lead.renewal_date).toBe("2027-03-03");
    expect(lead.type).toBe("Renewal");
  });

  it("picks up a second contact", () => {
    const text = "Met Anil at Bharat Steels. 9845012345, anil@bharat.in; accounts 9845054321 accounts@bharat.in";
    const { lead } = cleanExtractedLead(heuristicParseText(text, TODAY), { sourceText: text, today: TODAY });
    expect(lead.client_name).toBe("Bharat Steels");
    expect(lead.poc_contact_number).toBe("9845012345");
    expect(lead.poc2_contact_number).toBe("9845054321");
    expect(lead.poc2_email_id).toBe("accounts@bharat.in");
  });

  it("does not mistake an ordinary sentence for a company", () => {
    const raw = heuristicParseText("call back after lunch", TODAY);
    expect(raw.client_name).toBe("");
    expect(raw.poc_name).toBe("");
  });
});
