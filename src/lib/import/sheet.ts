// Turns pasted text or an uploaded sheet into rows of cells, and makes a
// first pass at mapping each row to lead fields without AI. The AI mapper
// improves on this; this pass also runs when AI is unavailable, and decides
// nothing the user cannot see and edit.

import { excelSerialToIso, parseLooseDate } from "@/lib/date-parse";
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

/**
 * Splits delimited text into rows of cells. A cell that starts with a quote
 * may hold the delimiter, line breaks and doubled quotes, as Excel and Google
 * Sheets write them when copying or exporting.
 */
export function splitDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cellStart) {
      quoted = true;
      cellStart = false;
    } else if (c === delimiter) {
      row.push(cell);
      cell = "";
      cellStart = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      cellStart = true;
    } else {
      cell += c;
      if (c !== " ") cellStart = false;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows.map((cells) => cells.map((c) => c.trim()));
}

/** Splits one CSV line, honouring quotes. */
export function splitCsvLine(line: string): string[] {
  return splitDelimited(line.replace(/[\r\n]+/g, " "), ",")[0];
}

export function looksLikeHeader(cells: string[]): boolean {
  const text = cells.join(" ").toLowerCase();
  return HEADER_WORDS.some((word) => text.includes(word));
}

/** Parses pasted TSV or CSV. Row numbers are 1-based over the data rows. */
export function parsePastedSheet(text: string): ParsedSheet {
  const clean = text.replace(/^\uFEFF/, "");
  const firstLine = clean.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  const parsed = splitDelimited(clean, firstLine.includes("\t") ? "\t" : ",").filter((cells) =>
    cells.some((c) => c !== ""),
  );
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
  // A date column formatted as a number holds an Excel serial (46300 = 05 Oct 2026).
  const serialDate = /^\d{5}(?:\.\d+)?$/.test(dateCell) ? excelSerialToIso(Number(dateCell)) : null;
  // Without a header, the first cell that reads as a date is the renewal.
  const headerlessDate =
    sheet.header.length === 0
      ? (row.cells.filter((c) => !EMAIL.test(c)).map((c) => parseLooseDate(c, today)).find(Boolean) ?? null)
      : null;
  const renewalDate =
    serialDate ?? parseLooseDate(dateCell, today) ?? parseLooseDate(remarks, today) ?? headerlessDate ?? "";

  const policyText = cellFor("type of policy", "policy", "product", "cover");
  const contactCell = cellFor("contact person", "poc name", "name") || "";
  const { name, designation } = splitNameAndDesignation(contactCell.replace(EMAIL, "").replace(/\+?\d[\d\s-]{6,}\d/g, ""));

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
