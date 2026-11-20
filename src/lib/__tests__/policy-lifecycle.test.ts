import { describe, expect, it } from "vitest";

import { clientCode, leadCode, parseCode, policyYear } from "@/lib/codes";
import { canAutoRenew, canBeOverdue, isOneTimeProduct, needsRenewalDate, statusesFor } from "@/lib/domain";
import { checkPolicy, cleanPolicyReading, hasDifferences, sameInsured, type PolicyReading } from "@/lib/policy-check";

describe("lead and client codes", () => {
  it("writes lead codes from the id and client codes from the number and policy year", () => {
    expect(leadCode(42)).toBe("LEAD-0042");
    expect(leadCode(12345)).toBe("LEAD-12345");
    expect(clientCode(7, 2026)).toBe("CAP-CLI-2026-0007");
    expect(policyYear("2027-04-01", "2026-11-20")).toBe(2027);
    expect(policyYear(null, "2026-11-20")).toBe(2026);
  });

  it("reads codes typed in search, any year finding the same client", () => {
    expect(parseCode("LEAD-0042")).toEqual({ leadId: 42 });
    expect(parseCode(" lead 42 ")).toEqual({ leadId: 42 });
    expect(parseCode("CAP-CLI-2026-0007")).toEqual({ clientNo: 7 });
    expect(parseCode("cap_cli_2025_0007")).toEqual({ clientNo: 7 });
    expect(parseCode("CLI-7")).toEqual({ clientNo: 7 });
    expect(parseCode("Acme")).toBeNull();
    expect(parseCode("2026")).toBeNull();
  });
});

describe("Auto Renewed and Travel", () => {
  it("offers Auto Renewed only on retail term life, and keeps it on a lead that already has it", () => {
    expect(canAutoRenew({ business_type: "Retail", policy_product: "Life" })).toBe(true);
    expect(canAutoRenew({ business_type: "Corporate", policy_product: "Life" })).toBe(false);
    expect(statusesFor({ business_type: "Retail", policy_product: "Life" })).toContain("Auto Renewed");
    expect(statusesFor({ business_type: "Retail", policy_product: "Health" })).not.toContain("Auto Renewed");
    expect(statusesFor({ business_type: "Retail", policy_product: "Health" }, "Auto Renewed")).toContain("Auto Renewed");
    expect(statusesFor({ business_type: "Corporate", policy_product: "Health" })).not.toContain("Renewed");
  });

  it("treats Travel as one-time: no renewal date needed", () => {
    expect(isOneTimeProduct("Travel")).toBe(true);
    expect(needsRenewalDate("Renewal", "Travel")).toBe(false);
    expect(needsRenewalDate("Renewal", "Health")).toBe(true);
  });

  it("lets Closed Won be overdue but never a lead waiting for its policy", () => {
    expect(canBeOverdue("Closed Won")).toBe(true);
    expect(canBeOverdue("Closed Awaiting Policy")).toBe(false);
    expect(canBeOverdue("Auto Renewed")).toBe(false);
  });
});

describe("policy checks", () => {
  const lead = { client_name: "Sharma Textiles Pvt Ltd", policy_product: "Health", renewal_date: "2026-12-01" };
  const reading: PolicyReading = cleanPolicyReading({
    insured_name: "SHARMA TEXTILES PRIVATE LIMITED",
    insurer: "Star Health",
    policy_number: "P/161/2026/123",
    policy_product: "Health",
    plan_name: "Group Mediclaim",
    policy_start_date: "2026-12-01",
    policy_end_date: "2027-11-30",
    premium: "₹45,000",
    sum_insured: 500000,
  });
  const values = {
    policy_start_date: "2026-12-01",
    policy_end_date: "2027-11-30",
    premium: 45200,
    sum_insured: null,
    insurer: "",
    policy_number: "p-161-2026-123",
  };

  it("cleans what the AI read", () => {
    expect(reading.premium).toBe(45000);
    expect(cleanPolicyReading({ policy_start_date: "2026-02-30", premium: -1 })).toMatchObject({ policy_start_date: "", premium: null });
  });

  it("matches a policy that agrees with the lead, within 1% on premium and ignoring punctuation in the number", () => {
    const checks = checkPolicy(reading, values, lead);
    expect(checks.map((c) => [c.field, c.result])).toEqual([
      ["insured_name", "match"],
      ["product", "match"],
      ["policy_start_date", "match"],
      ["policy_end_date", "match"],
      ["premium", "match"],
      ["policy_number", "match"],
      ["term", "match"],
      ["renewal_gap", "match"],
    ]);
    expect(hasDifferences(checks)).toBe(false);
  });

  it("flags another client's policy, a wrong date, a premium far off and a start far from the renewal date", () => {
    const other = checkPolicy({ ...reading, insured_name: "Gupta Motors", premium: 60000 }, { ...values, policy_start_date: "2027-03-01" }, lead);
    const result = Object.fromEntries(other.map((c) => [c.field, c.result]));
    expect(result).toMatchObject({ insured_name: "differs", premium: "differs", policy_start_date: "differs", renewal_gap: "differs" });
    expect(hasDifferences(other)).toBe(true);
    expect(sameInsured("M/s Sharma Textiles", "Sharma Textiles Pvt. Ltd.")).toBe(true);
  });

  it("checks only the dates when the document could not be read, and allows short Travel policies", () => {
    expect(checkPolicy(null, values, lead).map((c) => c.field)).toEqual(["term", "renewal_gap"]);
    const short = { ...values, policy_end_date: "2026-12-15" };
    expect(checkPolicy(null, short, lead)[0].result).toBe("differs");
    expect(checkPolicy(null, short, { ...lead, policy_product: "Travel" })).toEqual([
      expect.objectContaining({ field: "term", result: "match" }),
    ]);
  });
});
