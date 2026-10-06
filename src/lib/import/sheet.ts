// Turns pasted text or an uploaded sheet into rows of cells, and makes a
// first pass at mapping each row to lead fields without AI. The AI mapper
// improves on this; this pass also runs when AI is unavailable, and decides
// nothing the user cannot see and edit.

import { parseLooseDate } from "@/lib/date-parse";
import { splitNameAndDesignation } from "@/lib/ai/lead-cleanup";

export type SheetRow = { row: number; cells: string[] };

export type ParsedSheet = { header: string[]; rows: SheetRow[] };

const HEADER_WORDS = [
  "name of the client",
  "client name",
  "insured name",
  "contact details",
  "contact person",
  "contact number",
  "date of renewal",
  "date of referral",
  "location/vertical",
  "policy",
  "remarks",
  "sr no",
  "poc name",
  "email",
];

/** Splits a CSV line, honouring quotes. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else quoted = false;
      } else current += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      cells.push(current);
      current = "";
    } else current += c;
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

export function looksLikeHeader(cells: string[]): boolean {
  const text = cells.join(" ").toLowerCase();
  return HEADER_WORDS.some((word) => text.includes(word));
}

/** Parses pasted TSV or CSV. Row numbers are 1-based over the data rows. */
export function parsePastedSheet(text: string): ParsedSheet {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const split = (line: string) => (line.includes("\t") ? line.split("\t").map((c) => c.trim()) : splitCsvLine(line));
  const parsed = lines.map(split);
  const header = parsed.length > 0 && looksLikeHeader(parsed[0]) ? parsed[0] : [];
  const body = header.length > 0 ? parsed.slice(1) : parsed;
  return { header, rows: body.map((cells, i) => ({ row: i + 1, cells })) };
}

/** Same shape from an already-read spreadsheet (read-excel-file gives cells, not text). */
export function fromCellMatrix(matrix: readonly (readonly unknown[])[]): ParsedSheet {
  const toText = (value: unknown): string => {
    if (value == null) return "";
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).trim();
  };
  const rows = matrix.map((cells) => [...cells].map(toText)).filter((cells) => cells.some((c) => c !== ""));
  const header = rows.length > 0 && looksLikeHeader(rows[0]) ? rows[0] : [];
  const body = header.length > 0 ? rows.slice(1) : rows;
  return { header, rows: body.map((cells, i) => ({ row: i + 1, cells })) };
}

/** The input sent to Gemini: the header plus numbered rows. */
export function rowsAsText(sheet: ParsedSheet, rows: SheetRow[]): string {
  const header = sheet.header.length > 0 ? `Header: ${sheet.header.join(" | ")}\n` : "";
  return header + rows.map((r) => `[${r.row}] ${r.cells.join(" | ")}`).join("\n");
}

const EMAIL = /[^\s@,;:<>()"']+@[^\s@,;:<>()"']+\.[a-z]{2,}/i;
const PHONE = /(?:\+?91[\s-]?)?\b\d{10}\b|\b\d{5}[\s-]\d{5}\b/;

/**
 * Heuristic mapping of one row: finds the email, phone, date, product and
 * names by looking at every cell, using the header where it helps.
 */
export function heuristicMapRow(sheet: ParsedSheet, row: SheetRow, today: string): Record<string, string> {
  const headers = sheet.header.map((h) => h.toLowerCase());
  // Words are tried in order, so "contact person" wins over a bare "name"
  // in a sheet whose first column is "NAME OF THE CLIENT".
  const cellFor = (...words: string[]): string => {
    for (const word of words) {
      const index = headers.findIndex((h) => h.includes(word));
      if (index >= 0) return row.cells[index] ?? "";
    }
    return "";
  };

  const joined = row.cells.join(" ");
  const email = EMAIL.exec(joined)?.[0] ?? "";
  const phone = PHONE.exec(joined)?.[0] ?? "";

  // The company comes from the sheet's client column. Only when the sheet has
  // no such column is it guessed: the longest cell that is not a contact, a
  // number or a date. An empty client cell stays empty, so the row is flagged
  // instead of being given a wrong name.
  const clientWords = ["name of the client", "client name", "insured name", "company", "client"];
  const hasClientColumn = headers.some((h) => clientWords.some((w) => h.includes(w)));
  let client = cellFor(...clientWords);
  if (!client && !hasClientColumn) {
    client =
      row.cells
        .filter(
          (c) =>
            c.length > 2 &&
            !EMAIL.test(c) &&
            !/^\+?[\d\s\-()]+$/.test(c) &&
            !parseLooseDate(c, today) &&
            c !== cellFor("contact person", "poc name", "name"),
        )
        .sort((a, b) => b.length - a.length)[0] ?? "";
  }

  const dateCell = cellFor("date of renewal", "renewal", "expiry", "date of referral", "referral");
  const remarks = cellFor("remark", "notes", "comment");
  const renewalDate = parseLooseDate(dateCell, today) ?? parseLooseDate(remarks, today) ?? "";

  const policyText = cellFor("type of policy", "policy", "product", "cover");
  const contactCell = cellFor("contact person", "poc name", "name") || "";
  const { name, designation } = splitNameAndDesignation(contactCell.replace(EMAIL, "").replace(/\+?[\d\s\-()]{8,}/g, ""));

  const location = cellFor("location", "vertical", "address");
  const status = cellFor("status");
  const notes = [
    remarks ? `Remarks: ${remarks}` : "",
    location ? `Location: ${location}` : "",
    status ? `Status: ${status}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    client_name: client,
    type: renewalDate ? "Renewal" : "New",
    business_type: "",
    policy_product: policyText || joined,
    sub_product_name: policyText,
    renewal_date: renewalDate,
    address: location,
    poc_name: name,
    poc_designation: designation,
    poc_contact_number: phone,
    poc_email_id: email,
    poc2_name: "",
    poc2_designation: "",
    poc2_contact_number: "",
    poc2_email_id: "",
    notes: notes || (sheet.header.length === 0 ? joined : ""),
  };
}
