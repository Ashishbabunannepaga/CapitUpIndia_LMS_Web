import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { InvalidInputError } from "../errors";
import { createLead, getLead, setLeadStatus, updateLead } from "../leads";
import { testWorld } from "./helpers";

// Audit follow-ups: why a lead was lost, where it came from, and the policy
// details (premium, insurer, policy number).

let w: Awaited<ReturnType<typeof testWorld>>;

beforeAll(async () => {
  w = await testWorld();
});
afterAll(async () => {
  await w?.dispose();
});

describe("lost reason", () => {
  it("refuses Closed Lost without a reason, and Other without a note", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "No Reason Pvt Ltd" });
    await expect(setLeadStatus(w.ctx, w.amit, id, "Closed Lost")).rejects.toBeInstanceOf(InvalidInputError);
    await expect(setLeadStatus(w.ctx, w.amit, id, "Closed Lost", { lostReason: "Bad luck" })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(setLeadStatus(w.ctx, w.amit, id, "Closed Lost", { lostReason: "Other" })).rejects.toThrow(/few words/);
    expect((await getLead(w.ctx, w.amit, id))!.status).toBe("Prospect");
  });

  it("saves the reason and detail, and clears them when the lead is reopened", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Went Elsewhere Ltd" });
    await setLeadStatus(w.ctx, w.amit, id, "Closed Lost", { lostReason: "Competitor", lostReasonDetail: "Went with another broker" });
    let lead = (await getLead(w.ctx, w.amit, id))!;
    expect([lead.status, lead.lost_reason, lead.lost_reason_detail]).toEqual(["Closed Lost", "Competitor", "Went with another broker"]);

    await setLeadStatus(w.ctx, w.amit, id, "Follow-up");
    lead = (await getLead(w.ctx, w.amit, id))!;
    expect([lead.lost_reason, lead.lost_reason_detail]).toEqual(["", ""]);
  });

  it("lets an edit form close a lead with a reason, and refuses one without", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Form Lost Co" });
    await expect(updateLead(w.ctx, w.amit, id, { status: "Closed Lost" })).rejects.toBeInstanceOf(InvalidInputError);
    await updateLead(w.ctx, w.amit, id, { status: "Closed Lost", lost_reason: "No Response" });
    expect((await getLead(w.ctx, w.amit, id))!.lost_reason).toBe("No Response");
  });

  it("still lets people edit a lead that was lost before reasons existed", async () => {
    const id = await createLead(w.ctx, w.amit, { client_name: "Old Loss Co", status: "Closed Lost" });
    // Simulate a row from before migration 0013.
    await w.d1.prepare(`update leads set lost_reason = '', lost_reason_detail = '' where id = ?`).bind(id).run();
    await updateLead(w.ctx, w.amit, id, { notes: "called once more" });
    expect((await getLead(w.ctx, w.amit, id))!.notes).toBe("called once more");
  });
});

describe("lead source and policy details", () => {
  it("stores source, premium, insurer and policy number", async () => {
    const id = await createLead(w.ctx, w.amit, {
      client_name: "Premium Paying Pvt Ltd",
      lead_source: "Referral",
      premium_inr: 125000.5,
      insurer_name: "  Star Health  ",
      policy_number: "P-123/45",
    });
    const lead = (await getLead(w.ctx, w.amit, id))!;
    expect([lead.lead_source, lead.premium_inr, lead.insurer_name, lead.policy_number]).toEqual([
      "Referral",
      125000.5,
      "Star Health",
      "P-123/45",
    ]);
  });

  it("refuses an unknown source and a negative premium", async () => {
    await expect(createLead(w.ctx, w.amit, { client_name: "Bad Source Co", lead_source: "Carrier pigeon" as never })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(createLead(w.ctx, w.amit, { client_name: "Negative Co", premium_inr: -5 })).rejects.toBeInstanceOf(InvalidInputError);
  });
});
