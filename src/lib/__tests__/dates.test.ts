import { describe, expect, it } from "vitest";

import { excelSerialToIso, isoDate, isValidIsoDate, parseLooseDate } from "@/lib/date-parse";
import {
  addDays,
  businessDateOf,
  businessDateTimeToIso,
  daysBetween,
  formatDate,
  formatNoteTimestamp,
  relativeDays,
  renewalUrgency,
  startOfBusinessDay,
  todayInBusinessTz,
} from "@/lib/dates";

// Renewal dates drive reminders and colour coding, so every calendar edge
// (leap years, year ends, the IST midnight) is pinned here.

const TODAY = "2026-10-05";

describe("isoDate / isValidIsoDate", () => {
  it("accepts real calendar dates only", () => {
    expect(isoDate(2028, 2, 29)).toBe("2028-02-29");
    expect(isoDate(2027, 2, 29)).toBeNull();
    expect(isoDate(2100, 2, 29)).toBeNull(); // not a leap year
    expect(isoDate(2000, 2, 29)).toBe("2000-02-29");
    expect(isoDate(2026, 4, 31)).toBeNull();
    expect(isoDate(2026, 13, 1)).toBeNull();
    expect(isoDate(2026, 0, 1)).toBeNull();
    expect(isoDate(2026, 1, 0)).toBeNull();
    expect(isoDate(1899, 1, 1)).toBeNull();
    expect(isoDate(2201, 1, 1)).toBeNull();
    expect(isoDate(2026.5, 1, 1)).toBeNull();
    expect(isoDate(Number.NaN, 1, 1)).toBeNull();
  });

  it("validates the YYYY-MM-DD shape", () => {
    expect(isValidIsoDate("2026-10-05")).toBe(true);
    expect(isValidIsoDate("2026-02-30")).toBe(false);
    expect(isValidIsoDate("2026-1-5")).toBe(false);
    expect(isValidIsoDate("05-10-2026")).toBe(false);
    expect(isValidIsoDate("2026-10-05T00:00:00Z")).toBe(false);
    expect(isValidIsoDate("")).toBe(false);
  });
});

describe("excelSerialToIso", () => {
  it("converts spreadsheet serial dates", () => {
    expect(excelSerialToIso(46300)).toBe("2026-10-05");
    expect(excelSerialToIso(46300.75)).toBe("2026-10-05"); // time of day is dropped
    expect(excelSerialToIso(45351)).toBe("2024-02-29");
  });

  it("rejects numbers that are not plausible dates", () => {
    expect(excelSerialToIso(42)).toBeNull();
    expect(excelSerialToIso(9845012345)).toBeNull();
    expect(excelSerialToIso(Number.NaN)).toBeNull();
    expect(excelSerialToIso(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("parseLooseDate", () => {
  const cases: [string, string | null][] = [
    // numeric, day first
    ["2026-11-15", "2026-11-15"],
    ["2027-1-5", "2027-01-05"],
    ["1/1/2027", "2027-01-01"],
    ["15.11.2026", "2026-11-15"],
    ["expiry 05.03.27", "2027-03-05"],
    ["29-02-2028", "2028-02-29"],
    ["29-02-2027", null],
    ["renewal: 15/13/2026", null],
    // words
    ["renewal on 5th of March", "2027-03-05"],
    ["Mar 5th, 2027", "2027-03-05"],
    ["31 Dec 2026 renewal", "2026-12-31"],
    ["valid till 31st Dec", "2026-12-31"],
    ["dec 31", "2026-12-31"],
    ["15 jan", "2027-01-15"],
    ["jan", "2027-01-01"],
    ["3rd may", "2027-05-03"],
    ["May 2027", "2027-05-01"],
    ["23-feb-27", "2027-02-23"],
    ["SEPTEMBER 9", "2027-09-09"],
    ["sept 9", "2027-09-09"],
    ["30 feb", null],
    // not dates
    ["policy no 12-34-56", null],
    ["10:30 meeting", null],
    ["Q4", null],
    ["on 1-12", null],
    ["they may call back", null],
    ["   ", null],
  ];

  it.each(cases)("%s -> %s", (input, expected) => {
    expect(parseLooseDate(input, TODAY)).toBe(expected);
  });

  it("handles a null or undefined input", () => {
    expect(parseLooseDate(null, TODAY)).toBeNull();
    expect(parseLooseDate(undefined, TODAY)).toBeNull();
  });

  it("rolls dates without a year across the year end", () => {
    expect(parseLooseDate("15 Jan", "2026-12-20")).toBe("2027-01-15");
    expect(parseLooseDate("15 Dec", "2026-12-20")).toBe("2026-12-15");
    expect(parseLooseDate("29 Feb", "2027-03-01")).toBe("2028-02-29");
    expect(parseLooseDate("29 Feb", "2026-03-01")).toBeNull(); // Feb 2027 has no 29th
  });

  it("returns the first date when a note has several", () => {
    expect(parseLooseDate("policy 15/11/2026 to 14/11/2027", TODAY)).toBe("2026-11-15");
  });
});

describe("business-time calendar", () => {
  it("uses the IST date, not the UTC one", () => {
    // 18:29 UTC is 23:59 IST; 18:30 UTC is already the next day in India.
    expect(todayInBusinessTz(new Date("2026-10-05T18:29:00Z"))).toBe("2026-10-05");
    expect(todayInBusinessTz(new Date("2026-10-05T18:30:00Z"))).toBe("2026-10-06");
    expect(businessDateOf("2026-12-31T19:00:00Z")).toBe("2027-01-01");
  });

  it("converts business times to UTC", () => {
    expect(startOfBusinessDay("2026-10-05")).toBe("2026-10-04T18:30:00.000Z");
    expect(businessDateTimeToIso("2026-10-05", "10:00")).toBe("2026-10-05T04:30:00.000Z");
    expect(businessDateTimeToIso("2026-10-05", "")).toBe("2026-10-05T04:30:00.000Z");
  });

  it("adds days across month, year and leap-day boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-10-05", 0)).toBe("2026-10-05");
  });

  it("counts whole days between dates", () => {
    expect(daysBetween("2026-10-05", "2026-10-05")).toBe(0);
    expect(daysBetween("2026-10-05", "2026-10-06")).toBe(1);
    expect(daysBetween("2026-10-05", "2026-10-04")).toBe(-1);
    expect(daysBetween("2026-12-31", "2027-12-31")).toBe(365);
    expect(daysBetween("2028-01-01", "2029-01-01")).toBe(366);
  });
});

describe("renewalUrgency", () => {
  const cases: [string, string][] = [
    ["2026-10-04", "overdue"],
    ["2025-01-01", "overdue"],
    ["2026-10-05", "today"],
    ["2026-10-06", "week"],
    ["2026-10-12", "week"],
    ["2026-10-13", "month"],
    ["2026-11-04", "month"],
    ["2026-11-05", "later"],
  ];
  it.each(cases)("%s is %s", (date, urgency) => {
    expect(renewalUrgency(date, TODAY)).toBe(urgency);
  });
});

describe("relativeDays", () => {
  it("speaks in plain words", () => {
    expect(relativeDays("2026-10-05", TODAY)).toBe("Today");
    expect(relativeDays("2026-10-06", TODAY)).toBe("Tomorrow");
    expect(relativeDays("2026-10-04", TODAY)).toBe("Yesterday");
    expect(relativeDays("2026-10-17", TODAY)).toBe("in 12 days");
    expect(relativeDays("2026-10-02", TODAY)).toBe("3 days ago");
  });
});

describe("formatting", () => {
  it("formats dates and note timestamps in business time", () => {
    expect(formatDate("2026-10-05")).toBe("05 Oct 2026");
    expect(formatDate("2026-10-05T23:00:00Z")).toBe("05 Oct 2026");
    expect(formatDate(null)).toBe("");
    expect(formatDate("")).toBe("");
    expect(formatNoteTimestamp("2026-10-05T09:00:00Z")).toBe("05 Oct 2026, 14:30");
    expect(formatNoteTimestamp("2026-12-31T18:45:00Z")).toBe("01 Jan 2027, 00:15");
  });
});
