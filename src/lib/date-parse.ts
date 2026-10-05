// Turns the date shapes found in agent notes and insurance sheets into
// YYYY-MM-DD. Dates are day-first (Indian convention). A month or day without
// a year means its next occurrence: months before the current one roll to
// next year, the current month stays this year. Never invents a date: when
// nothing parses, the result is null.

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const MONTH_PATTERN = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** YYYY-MM-DD when the parts form a real calendar date, else null. */
export function isoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function isValidIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return Boolean(m && isoDate(Number(m[1]), Number(m[2]), Number(m[3])));
}

function expandYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

/** Year of the next occurrence of `month`, judged from `today` (YYYY-MM-DD). */
function nextYearFor(month: number, today: string): number {
  const year = Number(today.slice(0, 4));
  const currentMonth = Number(today.slice(5, 7));
  return month < currentMonth ? year + 1 : year;
}

/** Excel stores dates as days since 1899-12-30. */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000);
  return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Finds the first date in free text. `today` is YYYY-MM-DD in business time.
 * Handles 2026-10-15, 15-10-2026, 15/10/26, 15.10.2026, "23rd Feb 2027",
 * "23 Feb", "Feb 23", "20-Apr", "Apr-15", "October 2026" and "may renewal".
 */
export function parseLooseDate(input: string | null | undefined, today: string): string | null {
  // "may" is usually the verb ("they may renew"); only treat it as the month
  // next to a number or a word like "renewal".
  const text = (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/(?<!\d(?:st|nd|rd|th)?[\s\-/.]*)\bmay\b(?![\s\-/.,]*(?:\d|renewal|month|end\b|expir))/g, " ");
  if (!text.trim()) return null;

  let m = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(text);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/.exec(text);
  if (m) return isoDate(expandYear(Number(m[3])), Number(m[2]), Number(m[1]));

  // 23rd Feb 2027 / 23 feb / 20-Apr / 23-feb-27
  m = new RegExp(`\\b(\\d{1,2})\\s*(?:st|nd|rd|th)?[\\s\\-/.,]*(?:of\\s+)?${MONTH_PATTERN}\\b[\\s\\-/.,']*(\\d{4}|\\d{2}(?!\\d))?`).exec(text);
  if (m) {
    const month = MONTHS[m[2]];
    const year = m[3] ? expandYear(Number(m[3])) : nextYearFor(month, today);
    return isoDate(year, month, Number(m[1]));
  }

  // Feb 23, 2027 / Apr-15 / October 2026
  m = new RegExp(`\\b${MONTH_PATTERN}\\b[\\s\\-/.,]*(\\d{1,4})?(?:st|nd|rd|th)?(?:[\\s,]+(\\d{4}))?`).exec(text);
  if (m) {
    const month = MONTHS[m[1]];
    const first = m[2] ? Number(m[2]) : null;
    if (first !== null && m[2].length === 4) return isoDate(first, month, 1);
    if (first !== null && first >= 1 && first <= 31) {
      const year = m[3] ? Number(m[3]) : nextYearFor(month, today);
      return isoDate(year, month, first);
    }
    return isoDate(nextYearFor(month, today), month, 1);
  }

  return null;
}
