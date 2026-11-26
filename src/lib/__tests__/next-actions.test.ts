import { describe, expect, it } from "vitest";

import { rankNextActions } from "../next-actions";

const lead = (id: number, name: string, renewal: string, phone = "98480 12345") => ({
  id,
  client_name: name,
  renewal_date: renewal,
  policy_product: "Health",
  poc_name: "Rajesh Kumar",
  poc_contact_number: phone,
  poc_email_id: "rajesh@acme.test",
});

describe("rankNextActions", () => {
  const base = { today: "2031-03-10", now: new Date("2031-03-10T06:30:00.000Z"), agentName: "Sravani", renewals: [], overdueRenewals: [], awaitingPolicy: [] };

  it("puts approvals and overdue P1 work first, then renewals by closeness, and caps the list", () => {
    const items = rankNextActions({
      ...base,
      tasks: [
        { id: 1, title: "Later P3", priority: "P3", due_at: "2031-03-20T12:30:00.000Z", approval: null, lead_name: null },
        { id: 2, title: "Overdue KYC", priority: "P1", due_at: "2031-03-09T12:30:00.000Z", approval: null, lead_name: "Acme" },
        { id: 3, title: "Discount for Acme", priority: "P2", due_at: null, approval: "pending", lead_name: null },
      ],
      renewals: [lead(10, "Zenith", "2031-03-12"), lead(11, "Far Away", "2031-04-01"), lead(12, "Soon Co", "2031-03-11")],
      overdueRenewals: [lead(13, "Late Ltd", "2031-03-05")],
    });
    expect(items.map((i) => i.key)).toEqual(["t2", "a3", "o13", "r12", "r10"]);
    expect(items.find((i) => i.key === "t2")?.why).toBe("P1 task, overdue · Acme.");
  });

  it("drafts a WhatsApp message, a call link and an email for client actions", () => {
    const [item] = rankNextActions({ ...base, tasks: [], renewals: [lead(10, "Zenith", "2031-03-12")] });
    const wa = item?.links.find((l) => l.label === "WhatsApp")?.href ?? "";
    expect(wa.startsWith("https://wa.me/919848012345?text=")).toBe(true);
    expect(decodeURIComponent(wa)).toContain("Hello Rajesh, this is Sravani from CapitUp India. Your health policy renews on 2031-03-12.");
    expect(item?.links.map((l) => l.label)).toEqual(["WhatsApp", "Call", "Email", "Open"]);
  });

  it("leaves out contact links the lead has no details for", () => {
    const [item] = rankNextActions({ ...base, tasks: [], overdueRenewals: [{ ...lead(13, "No Phone", "2031-03-01", ""), poc_email_id: "" }] });
    expect(item?.links.map((l) => l.label)).toEqual(["Open"]);
  });
});
