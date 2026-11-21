import { describe, expect, it } from "vitest";

import { pickMergeTarget } from "../import/merge";

// R8 (enterprise audit): importing "Acme / Fire" next to "Acme / Health"
// must not silently drop the Fire lead.
describe("import merge target", () => {
  it("creates a lead for a new company", () => {
    expect(pickMergeTarget([], "Fire or Property")).toEqual({ action: "create" });
  });
  it("merges into the lead with the same product", () => {
    expect(pickMergeTarget([{ id: 3, policy_product: "Health" }, { id: 7, policy_product: "Fire or Property" }], "Fire or Property")).toEqual({
      action: "merge",
      leadId: 7,
      setProduct: false,
    });
  });
  it("adds a different product as its own lead instead of dropping it", () => {
    expect(pickMergeTarget([{ id: 3, policy_product: "Health" }], "Fire or Property")).toEqual({
      action: "new_product",
      existingProducts: ["Health"],
    });
  });
  it("fills a lead whose product is still Not Specified", () => {
    expect(pickMergeTarget([{ id: 3, policy_product: "Health" }, { id: 4, policy_product: "Not Specified" }], "Marine")).toEqual({
      action: "merge",
      leadId: 4,
      setProduct: true,
    });
  });
  it("a row without a product only adds contacts to the oldest lead", () => {
    expect(pickMergeTarget([{ id: 9, policy_product: "Motor" }, { id: 2, policy_product: "Health" }], "Not Specified")).toEqual({
      action: "merge",
      leadId: 2,
      setProduct: false,
    });
  });
});
