import { describe, expect, it } from "vitest";

import { calendarCategories } from "@/lib/domain";

// The calendar colours follow the Android app's planner.

const lead = (over: Partial<Parameters<typeof calendarCategories>[1] & object> = {}) => ({
  business_type: "Corporate" as const,
  policy_product: "Health" as const,
  status: "Prospect" as const,
  ...over,
});

describe("calendar colours", () => {
  it("a corporate renewal is GMC", () => {
    expect(calendarCategories(true, lead())).toEqual(["gmc_renewal"]);
    expect(calendarCategories(true, lead({ policy_product: "Fire or Property" }))).toEqual(["gmc_renewal"]);
  });

  it("a retail account or a motor policy renews as retail", () => {
    expect(calendarCategories(true, lead({ business_type: "Retail" }))).toEqual(["retail_renewal"]);
    expect(calendarCategories(true, lead({ policy_product: "Motor" }))).toEqual(["retail_renewal"]);
  });

  it("a renewal for an active client carries both colours", () => {
    expect(calendarCategories(true, lead({ status: "Active Client" }))).toEqual(["gmc_renewal", "active_client"]);
    expect(calendarCategories(true, lead({ business_type: "Retail", status: "Active Client" }))).toEqual([
      "retail_renewal",
      "active_client",
    ]);
  });

  it("other entries are tasks, unless they are for an active client", () => {
    expect(calendarCategories(false, null)).toEqual(["task"]);
    expect(calendarCategories(false, lead())).toEqual(["task"]);
    expect(calendarCategories(false, lead({ status: "Active Client" }))).toEqual(["active_client"]);
  });

  it("a renewal whose lead is gone still counts as GMC", () => {
    expect(calendarCategories(true, null)).toEqual(["gmc_renewal"]);
  });
});
