import { describe, expect, it } from "vitest";

import { businessHhmm, formatClockTime, formatHhmm, from12Hour, parseHhmm, to12Hour, toHhmm } from "@/lib/clock";

describe("12/24-hour clock", () => {
  it("converts between 24-hour and 12-hour hours", () => {
    expect([0, 1, 11, 12, 13, 23].map(to12Hour)).toEqual([
      { hour: 12, period: "AM" },
      { hour: 1, period: "AM" },
      { hour: 11, period: "AM" },
      { hour: 12, period: "PM" },
      { hour: 1, period: "PM" },
      { hour: 11, period: "PM" },
    ]);
    expect(from12Hour(12, "AM")).toBe(0);
    expect(from12Hour(12, "PM")).toBe(12);
    expect(from12Hour(9, "AM")).toBe(9);
    expect(from12Hour(9, "PM")).toBe(21);
    for (let h = 0; h < 24; h++) {
      const { hour, period } = to12Hour(h);
      expect(from12Hour(hour, period)).toBe(h);
    }
  });

  it("formats and parses HH:mm", () => {
    expect(formatHhmm("14:05", "12h")).toBe("2:05 PM");
    expect(formatHhmm("00:30", "12h")).toBe("12:30 AM");
    expect(formatHhmm("14:05", "24h")).toBe("14:05");
    expect(parseHhmm("24:00")).toBeNull();
    expect(parseHhmm("9:00")).toBeNull();
    expect(parseHhmm("09:00")).toEqual({ hours: 9, minutes: 0 });
    expect(toHhmm(7, 5)).toBe("07:05");
  });

  it("shows timestamps in India time", () => {
    // 08:30 UTC is 14:00 in India.
    expect(formatClockTime("2030-01-10T08:30:00.000Z", "12h")).toBe("2:00 PM");
    expect(formatClockTime("2030-01-10T08:30:00.000Z", "24h")).toBe("14:00");
    expect(businessHhmm("2030-01-10T18:45:00.000Z")).toBe("00:15");
  });
});
