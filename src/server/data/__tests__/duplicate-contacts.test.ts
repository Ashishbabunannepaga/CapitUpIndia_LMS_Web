import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createLead } from "../leads";
import { emailKey, findSimilarLeads, phoneKey } from "../duplicates";
import { testWorld } from "./helpers";

// Audit R9: retail clients are people, so the duplicate check also matches a
// POC's phone number (last 10 digits) or email already on another lead.

let w: Awaited<ReturnType<typeof testWorld>>;

beforeAll(async () => {
  w = await testWorld();
}, 60_000);

afterAll(async () => {
  await w?.dispose();
});

describe("duplicate check on phone and email", () => {
  it("normalises phone numbers and ignores dummies", () => {
    expect(phoneKey("+91 98450-12345")).toBe("9845012345");
    expect(phoneKey("098450 12345")).toBe("9845012345");
    expect(phoneKey("0000000000")).toBeNull();
    expect(phoneKey("1234567890")).toBeNull();
    expect(phoneKey("12345")).toBeNull();
    expect(emailKey(" Rahul@Example.com ")).toBe("rahul@example.com");
    expect(emailKey("na@na.com")).toBeNull();
    expect(emailKey("not an email")).toBeNull();
  });

  it("finds the same person typed under another name, and tells the agent whose lead it is", async () => {
    const id = await createLead(w.ctx, w.amit, {
      client_name: "Rahul Sharma",
      business_type: "Retail",
      poc_name: "Rahul Sharma",
      poc_contact_number: "+91 98450-12345",
      poc_email_id: "rahul.s@example.com",
    });

    const byPhone = await findSimilarLeads(w.ctx, w.neha, "R. Sharma Family", { phones: ["9845012345"] });
    expect(byPhone).toEqual([expect.objectContaining({ lead_id: id, matched_on: "phone", assigned_agent_name: "Amit Agent" })]);

    const byEmail = await findSimilarLeads(w.ctx, w.neha, "Someone Else", { emails: ["RAHUL.S@example.com"] });
    expect(byEmail).toEqual([expect.objectContaining({ lead_id: id, matched_on: "email" })]);

    // A name match comes first and is not listed twice.
    const both = await findSimilarLeads(w.ctx, w.neha, "Rahul Sharma", { phones: ["9845012345"] });
    expect(both.filter((m) => m.lead_id === id)).toEqual([expect.objectContaining({ matched_on: "name", is_exact: true })]);

    // The lead itself is left out when it is the one being edited.
    expect(await findSimilarLeads(w.ctx, w.amit, "", { phones: ["9845012345"], excludeId: id })).toEqual([]);
  });
});
