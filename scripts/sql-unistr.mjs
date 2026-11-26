// D1's export writes text that holds newlines or other control characters as
// unistr('...\000a...'), a function only SQLite 3.50+ knows. The sqlite3 on
// GitHub's runners (and most machines) is older, so such a dump would not
// restore. rewriteUnistr turns every unistr('...') call outside string
// literals back into a plain '...' literal holding the same characters,
// so the dump restores with any sqlite3 and into D1.

const HEX = /^[0-9a-fA-F]+$/;

function decodeEscapes(body) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    let digits;
    let skip;
    if (next === "\\") {
      out += "\\";
      i += 1;
      continue;
    } else if (next === "u") {
      digits = body.slice(i + 2, i + 6);
      skip = 6;
    } else if (next === "+") {
      digits = body.slice(i + 2, i + 8);
      skip = 8;
    } else if (next === "U") {
      digits = body.slice(i + 2, i + 10);
      skip = 10;
    } else {
      digits = body.slice(i + 1, i + 5);
      skip = 5;
    }
    if (!HEX.test(digits) || digits.length !== skip - (skip === 5 ? 1 : 2)) {
      throw new Error(`Bad unistr escape near: ${body.slice(i, i + 12)}`);
    }
    out += String.fromCodePoint(parseInt(digits, 16));
    i += skip - 1;
  }
  return out;
}

/** Reads a SQL string literal starting at the opening quote; returns its raw body (with '' kept) and the index after the closing quote. */
function readLiteral(sql, start) {
  let i = start + 1;
  for (;;) {
    const close = sql.indexOf("'", i);
    if (close === -1) throw new Error("Unterminated string literal in the dump");
    if (sql[close + 1] === "'") {
      i = close + 2;
      continue;
    }
    return { body: sql.slice(start + 1, close), end: close + 1 };
  }
}

export function rewriteUnistr(sql) {
  const parts = [];
  let copyFrom = 0;
  let i = 0;
  while (i < sql.length) {
    const quote = sql.indexOf("'", i);
    if (quote === -1) break;
    const isCall =
      quote >= 7 &&
      sql.slice(quote - 7, quote).toLowerCase() === "unistr(" &&
      !/[A-Za-z0-9_]/.test(sql[quote - 8] ?? "");
    const { body, end } = readLiteral(sql, quote);
    if (isCall && sql[end] === ")") {
      parts.push(sql.slice(copyFrom, quote - 7), "'", decodeEscapes(body), "'");
      copyFrom = end + 1;
    }
    i = end;
  }
  parts.push(sql.slice(copyFrom));
  return parts.join("");
}
