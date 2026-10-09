import { describe, expect, it } from "vitest";

import { cleanExtractedLead } from "@/lib/ai/lead-cleanup";
import {
  fromCellMatrix,
  heuristicMapRow,
  looksLikeHeader,
  parsePastedSheet,
  rowsAsText,
  splitCsvLine,
  splitDelimited,
} from "@/lib/import/sheet";

// Sheets arrive pasted from Excel or Google Sheets, exported as CSV, or
// uploaded as .xlsx. Each shape has to land as the same rows.

const TODAY = "2026-10-05";

describe("splitDelimited", () => {
  it("honours quotes, doubled quotes and delimiters inside quotes", () => {
    expect(splitCsvLine('"Acme, Inc","He said ""hi""",plain')).toEqual(["Acme, Inc", 'He said "hi"', "plain"]);
    expect(splitCsvLine("a,,c,")).toEqual(["a", "", "c", ""]);
    expect(splitCsvLine('5" pipe,x')).toEqual(['5" pipe', "x"]);
  });

  it("keeps line breaks inside a quoted cell in one row", () => {
    const text = 'Client,Remarks\r\nAcme,"line one\r\nline two"\r\nBeta,ok';
    expect(splitDelimited(text, ",")).toEqual([
      ["Client", "Remarks"],
      ["Acme", "line one\r\nline two"],
      ["Beta", "ok"],
    ]);
  });

  it("reads tab-separated text with quoted cells", () => {
    expect(splitDelimited('Acme\t"a\tb"\tc', "\t")).toEqual([["Acme", "a\tb", "c"]]);
  });
});

describe("looksLikeHeader", () => {
  it("recognises the headers of the team's sheets", () => {
    expect(looksLikeHeader(["Sr No", "Name of the Client", "Contact Details"])).toBe(true);
    expect(looksLikeHeader(["POC Name", "Email"])).toBe(true);
    expect(looksLikeHeader(["Renee Systems", "9845012345"])).toBe(false);
  });
});

describe("parsePastedSheet", () => {
  it("skips blank lines and numbers data rows from 1", () => {
    const sheet = parsePastedSheet("Client name,Email\n\nAcme,a@acme.in\n   \nBeta,b@beta.in\n");
    expect(sheet.header).toEqual(["Client name", "Email"]);
    expect(sheet.rows.map((r) => r.row)).toEqual([1, 2]);
    expect(sheet.rows[1].cells).toEqual(["Beta", "b@beta.in"]);
  });

  it("strips a byte-order mark so the header is still found", () => {
    const sheet = parsePastedSheet("﻿Client name,Email\nAcme,a@acme.in");
    expect(sheet.header[0]).toBe("Client name");
    expect(sheet.rows).toHaveLength(1);
  });

  it("keeps a multi-line remark from Excel in its row", () => {
    const sheet = parsePastedSheet('Client name\tRemarks\nAcme\t"Call Monday\nQuote sent"\nBeta\tok');
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0].cells[1]).toBe("Call Monday\nQuote sent");
  });

  it("returns nothing for empty input", () => {
    expect(parsePastedSheet("")).toEqual({ header: [], rows: [] });
    expect(parsePastedSheet("\n \n")).toEqual({ header: [], rows: [] });
  });
});

describe("fromCellMatrix", () => {
  it("turns spreadsheet values into text and drops empty rows", () => {
    const sheet = fromCellMatrix([
      ["Client name", "Date of renewal", "Lives"],
      [null, undefined, ""],
      ["Acme", new Date(Date.UTC(2026, 10, 15)), 120],
    ]);
    expect(sheet.header).toEqual(["Client name", "Date of renewal", "Lives"]);
    expect(sheet.rows).toEqual([{ row: 1, cells: ["Acme", "2026-11-15", "120"] }]);
  });
});

describe("rowsAsText", () => {
  it("numbers rows for the AI mapper", () => {
    const sheet = parsePastedSheet("Client name,Email\nAcme,a@acme.in");
    expect(rowsAsText(sheet, sheet.rows)).toBe("Header: Client name | Email\n[1] Acme | a@acme.in");
  });
});

describe("heuristicMapRow", () => {
  const map = (text: string, index = 0) => {
    const sheet = parsePastedSheet(text);
    return cleanExtractedLead(heuristicMapRow(sheet, sheet.rows[index], TODAY), { today: TODAY }).lead;
  };

  it("reads an Excel serial in the renewal column", () => {
    expect(map("Client name,Date of renewal\nAcme,46300").renewal_date).toBe("2026-10-05");
  });

  it("leaves an empty client cell empty instead of guessing", () => {
    expect(map("Client name,Contact person,Remarks\n,Priya,very long remark about the account").client_name).toBe("");
  });

  it("guesses the company when the sheet has no header", () => {
    const lead = map("Bharat Steels Pvt Ltd,9845012345,anil@bharat.in,15/11/2026");
    expect(lead.client_name).toBe("Bharat Steels Pvt Ltd");
    expect(lead.poc_contact_number).toBe("9845012345");
    expect(lead.poc_email_id).toBe("anil@bharat.in");
    expect(lead.renewal_date).toBe("2026-11-15");
    expect(lead.type).toBe("Renewal");
  });

  it("collects remarks, location and status into notes", () => {
    const lead = map("Client name,Location,Status,Remarks\nAcme,Pune,Hot,Wants GMC quote");
    expect(lead.notes).toBe("Remarks: Wants GMC quote\nLocation: Pune\nStatus: Hot");
    expect(lead.address).toBe("Pune");
    expect(lead.policy_product).toBe("Health");
  });

  it("takes the product from the policy column", () => {
    const lead = map("Client name,Type of policy\nAcme,Marine cargo");
    expect(lead.policy_product).toBe("Marine");
    expect(lead.sub_product_name).toBe("Marine cargo");
  });

  it("separates the contact's phone and email from their name", () => {
    const lead = map("Client name,Contact person\nAcme,Priya (HR) 98450 12345 priya@acme.in");
    expect(lead.poc_name).toBe("Priya");
    expect(lead.poc_designation).toBe("HR");
  });
});
