import { describe, expect, it } from "vitest";

import { addYears, isIsoDate } from "@/lib/dates";
import { calendarCategories, calendarProductLabel, isActiveClientStatus } from "@/lib/domain";
import { closesCycle, nextRenewalDate, rolloverForStatusChange } from "@/lib/renewal-rollover";

const today = "2026-11-17";

describe("addYears and isIsoDate", () => {
  it("keeps the day and month, and turns 29 Feb into 28 Feb in a common year", () => {
    expect(addYears("2026-12-07", 1)).toBe("2027-12-07");
    expect(addYears("2028-02-29", 1)).toBe("2029-02-28");
    expect(addYears("2027-12-07", -1)).toBe("2026-12-07");
  });

  it("accepts only real calendar dates", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("17/11/2026")).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });
});

describe("next renewal date when a cycle closes", () => {
  it("moves a renewal due soon, today or overdue by one year", () => {
    expect(nextRenewalDate("2026-12-07", today)).toBe("2027-12-07");
    expect(nextRenewalDate(today, today)).toBe("2027-11-17");
    expect(nextRenewalDate("2026-03-01", today)).toBe("2027-03-01");
  });

  it("moves an old record far enough to land after today", () => {
    expect(nextRenewalDate("2024-06-10", today)).toBe("2027-06-10");
    expect(nextRenewalDate("2025-11-17", today)).toBe("2027-11-17");
  });

  it("leaves dates already in the next cycle, and leads without a date, alone", () => {
    expect(nextRenewalDate("2027-05-01", today)).toBeNull();
    expect(nextRenewalDate(null, today)).toBeNull();
  });

  it("rolls only when a lead moves into Closed Won, Renewed or Closed Lost", () => {
    const lead = { status: "Quoted", renewal_date: "2026-12-07" };
    expect(rolloverForStatusChange(lead, "Closed Won", today)).toBe("2027-12-07");
    expect(rolloverForStatusChange(lead, "Renewed", today)).toBe("2027-12-07");
    expect(rolloverForStatusChange(lead, "Closed Lost", today)).toBe("2027-12-07");
    expect(rolloverForStatusChange(lead, "Follow-up", today)).toBeNull();
    expect(rolloverForStatusChange({ status: "Renewed", renewal_date: "2026-12-07" }, "Renewed", today)).toBeNull();
    // Already rolled: fixing Closed Won to Renewed does not add a second year.
    expect(rolloverForStatusChange({ status: "Closed Won", renewal_date: "2027-12-07" }, "Renewed", today)).toBeNull();
    expect(closesCycle("Prospect")).toBe(false);
  });
});

describe("Renewed is an active client", () => {
  it("counts Closed Won and Renewed as active clients, coloured as such on the calendar", () => {
    expect(isActiveClientStatus("Renewed")).toBe(true);
    expect(isActiveClientStatus("Closed Lost")).toBe(false);
    expect(calendarCategories(true, { business_type: "Corporate", policy_product: "Fire or Property", status: "Renewed" })).toEqual([
      "gmc_renewal",
      "active_client",
    ]);
  });
});

describe("calendar product names", () => {
  it("names each renewal by its own product, never GMC Health by default", () => {
    expect(calendarProductLabel("Fire or Property", "Corporate")).toBe("Fire");
    expect(calendarProductLabel("Health", "Corporate")).toBe("GMC");
    expect(calendarProductLabel("Health", "Retail")).toBe("Health");
    expect(calendarProductLabel("Motor", "Retail")).toBe("Motor");
    expect(calendarProductLabel("Marine", "Corporate")).toBe("Marine");
    expect(calendarProductLabel("Not Specified", "Corporate")).toBe("Renewal");
  });
});
