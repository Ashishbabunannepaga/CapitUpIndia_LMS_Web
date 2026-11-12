import { describe, expect, it } from "vitest";

import { calendarCategories, calendarPills, pillMatchesFilter } from "@/lib/domain";

// The calendar colours follow the Android app's planner.

const lead = (over: Partial<Parameters<typeof calendarCategories>[1] & object> = {}) => ({
  business_type: "Corporate" as const,
  policy_product: "Health" as const,
  status: "Prospect" as "Prospect" | "Closed Won",
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
    expect(calendarCategories(true, lead({ status: "Closed Won" }))).toEqual(["gmc_renewal", "active_client"]);
    expect(calendarCategories(true, lead({ business_type: "Retail", status: "Closed Won" }))).toEqual([
      "retail_renewal",
      "active_client",
    ]);
  });

  it("other entries are tasks, unless they are for an active client (Closed Won)", () => {
    expect(calendarCategories(false, null)).toEqual(["task"]);
    expect(calendarCategories(false, lead())).toEqual(["task"]);
    expect(calendarCategories(false, lead({ status: "Closed Won" }))).toEqual(["active_client"]);
  });

  it("a meeting is a meeting, and also an active client's when the lead is Closed Won", () => {
    expect(calendarCategories(false, null, "meeting")).toEqual(["meeting"]);
    expect(calendarCategories(false, lead(), "meeting")).toEqual(["meeting"]);
    expect(calendarCategories(false, lead({ status: "Closed Won" }), "meeting")).toEqual(["meeting", "active_client"]);
  });

  it("a renewal whose lead is gone still counts as GMC", () => {
    expect(calendarCategories(true, null)).toEqual(["gmc_renewal"]);
  });
});

describe("calendar day tiles", () => {
  it("a retail renewal is a red retail tile until the lead is Closed Won, then one green retail tile", () => {
    const pills = (over: Parameters<typeof lead>[0]) => calendarPills(calendarCategories(true, lead(over)));
    expect(pills({ business_type: "Retail" })).toEqual(["retail_renewal"]);
    expect(pills({ business_type: "Retail", status: "Closed Won" })).toEqual(["retail_won"]);
    expect(pills({ policy_product: "Motor", status: "Closed Won" })).toEqual(["retail_won"]);
  });

  it("other tiles are unchanged", () => {
    expect(calendarPills(calendarCategories(true, lead({ status: "Closed Won" })))).toEqual(["gmc_renewal", "active_client"]);
    expect(calendarPills(calendarCategories(false, lead({ status: "Closed Won" }), "meeting"))).toEqual(["meeting", "active_client"]);
    expect(calendarPills(calendarCategories(false, null))).toEqual(["task"]);
  });

  it("a green retail tile shows under the Retail and Active Clients filters", () => {
    expect(pillMatchesFilter("retail_won", "all")).toBe(true);
    expect(pillMatchesFilter("retail_won", "retail_renewal")).toBe(true);
    expect(pillMatchesFilter("retail_won", "active_client")).toBe(true);
    expect(pillMatchesFilter("retail_won", "gmc_renewal")).toBe(false);
    expect(pillMatchesFilter("retail_renewal", "active_client")).toBe(false);
  });
});
