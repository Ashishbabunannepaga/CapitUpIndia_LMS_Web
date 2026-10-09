import { describe, expect, it } from "vitest";

import { firstPhone, mailtoHref, telHref, whatsappHref } from "@/lib/contact-links";
import { formatNoteLine, isLeadStatus, isPolicyProduct } from "@/lib/domain";
import { leadsHref, parseLeadFilters, searchTerms } from "@/lib/lead-filters";
import { contactSchema, formDataToObject, leadFormSchema } from "@/lib/lead-schema";
import { safeNextPath } from "@/lib/safe-redirect";

// Everything a browser can send: form fields and URL parameters. Bad input
// must come back as a clear message or a safe default, never a crash.

describe("leadFormSchema", () => {
  const valid = { client_name: "  Acme  ", poc_name: "Priya", poc_email_id: " Priya@Acme.IN " };

  it("trims, lowercases and fills defaults", () => {
    const result = leadFormSchema.parse(valid);
    expect(result.client_name).toBe("Acme");
    expect(result.poc_email_id).toBe("priya@acme.in");
    expect(result.poc_designation).toBe("poc");
    expect(result.poc2_designation).toBe("");
    expect(result.type).toBe("New");
    expect(result.status).toBe("Prospect");
    expect(result.renewal_date).toBeNull();
    expect(result.assigned_agent_id).toBeNull();
    expect(result.visiting_card_path).toBeNull();
    expect(result.confirm_duplicate).toBe(false);
  });

  it("keeps an explicit designation", () => {
    expect(leadFormSchema.parse({ ...valid, poc_designation: "Director" }).poc_designation).toBe("Director");
  });

  const rejects: [string, Record<string, string>][] = [
    ["an empty client", { client_name: "   " }],
    ["a client over 300 characters", { client_name: "x".repeat(301) }],
    ["an impossible renewal date", { client_name: "Acme", renewal_date: "2026-02-30" }],
    ["a renewal date in another format", { client_name: "Acme", renewal_date: "15/11/2026" }],
    ["a bad email", { client_name: "Acme", poc_email_id: "priya@" }],
    ["letters in a phone", { client_name: "Acme", poc_contact_number: "98450abc" }],
    ["a phone over 32 characters", { client_name: "Acme", poc_contact_number: "9".repeat(33) }],
    ["an unknown status", { client_name: "Acme", status: "Won" }],
    ["an unknown product", { client_name: "Acme", policy_product: "Pet" }],
    ["an agent id that is not a uuid", { client_name: "Acme", assigned_agent_id: "1 or 1=1" }],
  ];
  it.each(rejects)("rejects %s", (_, input) => {
    expect(leadFormSchema.safeParse(input).success).toBe(false);
  });

  it("accepts the values the form sends", () => {
    const result = leadFormSchema.parse({
      client_name: "Acme",
      renewal_date: "2028-02-29",
      assigned_agent_id: "00000000-0000-0000-0000-000000000001",
      poc_contact_number: "+91 98450-12345, 080/4123",
      confirm_duplicate: "on",
    });
    expect(result.renewal_date).toBe("2028-02-29");
    expect(result.assigned_agent_id).toBe("00000000-0000-0000-0000-000000000001");
    expect(result.confirm_duplicate).toBe(true);
    expect(leadFormSchema.parse({ client_name: "Acme", assigned_agent_id: "unassigned" }).assigned_agent_id).toBeNull();
  });

  it("only reads known form fields", () => {
    const form = new FormData();
    form.set("client_name", "Acme");
    form.set("is_duplicate", "false");
    form.set("created_by", "someone");
    expect(formDataToObject(form)).toEqual({ client_name: "Acme" });
  });
});

describe("contactSchema", () => {
  it("needs a name, phone or email", () => {
    expect(contactSchema.safeParse({}).success).toBe(false);
    expect(contactSchema.safeParse({ name: "  " }).success).toBe(false);
    expect(contactSchema.safeParse({ phone: "9845012345" }).success).toBe(true);
    expect(contactSchema.safeParse({ email: "a@b.co" }).success).toBe(true);
  });
});

describe("parseLeadFilters", () => {
  it("defaults everything for an empty URL", () => {
    expect(parseLeadFilters({})).toEqual({
      view: "table",
      q: "",
      status: null,
      product: null,
      type: null,
      agent: null,
      renewal: null,
      duplicates: false,
      sort: "updated",
    });
  });

  it("ignores values that are not allowed, including object prototype keys", () => {
    const filters = parseLeadFilters({
      view: "grid",
      status: "Won",
      product: "toString",
      type: "constructor",
      agent: "not-an-id",
      renewal: "toString",
      sort: "constructor",
      duplicates: "yes",
    });
    expect(filters).toMatchObject({
      view: "table",
      status: null,
      product: null,
      type: null,
      agent: null,
      renewal: null,
      sort: "updated",
      duplicates: false,
    });
  });

  it("takes the first of repeated parameters and caps the search", () => {
    const filters = parseLeadFilters({ status: ["Quoted", "Prospect"], q: "x".repeat(150) });
    expect(filters.status).toBe("Quoted");
    expect(filters.q).toHaveLength(100);
  });

  it("round-trips through leadsHref", () => {
    const filters = parseLeadFilters({
      view: "kanban",
      q: "renee & co",
      status: "Follow-up",
      product: "Fire or Property",
      type: "Renewal",
      agent: "unassigned",
      renewal: "30",
      duplicates: "1",
      sort: "renewal_asc",
    });
    const url = new URL(leadsHref(filters), "https://lms.example");
    expect(parseLeadFilters(Object.fromEntries(url.searchParams))).toEqual(filters);
    expect(leadsHref({})).toBe("/leads");
    expect(leadsHref({ view: "table", sort: "updated" })).toBe("/leads");
  });
});

describe("searchTerms", () => {
  it("strips characters that would break or widen the PostgREST filter", () => {
    expect(searchTerms('renee),status.eq.Quoted,(client_name.ilike.*')).toEqual(["renee status.eq.Quoted client_name.ilike."]);
    expect(searchTerms("100%")).toEqual(["100"]);
    expect(searchTerms(`"o'brien"`)).toEqual(["o brien"]);
    expect(searchTerms("   ")).toEqual([]);
  });

  it("keeps emails searchable", () => {
    expect(searchTerms("priya@kaveri.in")).toEqual(["priya@kaveri.in"]);
  });

  it("also searches the bare digits of a phone number", () => {
    expect(searchTerms("98450 12345")).toEqual(["98450 12345", "9845012345"]);
    expect(searchTerms("+91-98450-12345")).toEqual(["+91-98450-12345", "919845012345"]);
    expect(searchTerms("9845012345")).toEqual(["9845012345"]);
    expect(searchTerms("2 wheeler")).toEqual(["2 wheeler"]);
  });
});

describe("contact links", () => {
  it("uses the first of several numbers", () => {
    expect(firstPhone("9845012345, 080-41234567")).toBe("9845012345");
    expect(firstPhone("9845012345 / 9845054321")).toBe("9845012345");
    expect(firstPhone("")).toBe("");
  });

  it("builds tel links only for dialable numbers", () => {
    expect(telHref("+91 98450-12345")).toBe("tel:+919845012345");
    expect(telHref("12345")).toBeNull();
    expect(telHref("")).toBeNull();
  });

  it("adds India's country code for WhatsApp", () => {
    expect(whatsappHref("98450 12345")).toBe("https://wa.me/919845012345");
    expect(whatsappHref("09845012345")).toBe("https://wa.me/919845012345");
    expect(whatsappHref("+91 98450 12345", "Hi Priya & team")).toBe(
      "https://wa.me/919845012345?text=Hi%20Priya%20%26%20team",
    );
    expect(whatsappHref("12345")).toBeNull();
  });

  it("encodes mail subjects and bodies", () => {
    expect(mailtoHref("a@b.co")).toBe("mailto:a@b.co");
    expect(mailtoHref("a@b.co", "Quote & renewal", "Line 1\nLine 2")).toBe(
      "mailto:a@b.co?subject=Quote%20%26%20renewal&body=Line%201%0ALine%202",
    );
    expect(mailtoHref("not-an-email")).toBeNull();
  });
});

describe("domain", () => {
  it("formats notes in business time", () => {
    expect(formatNoteLine("Priya", "2026-10-05T09:00:00Z", "Sent quote")).toBe("[Priya - 05 Oct 2026, 14:30]: Sent quote");
  });

  it("type-guards statuses and products", () => {
    expect(isLeadStatus("Closed Won")).toBe(true);
    expect(isLeadStatus("closed won")).toBe(false);
    expect(isLeadStatus(1)).toBe(false);
    expect(isPolicyProduct("Fire or Property")).toBe(true);
    expect(isPolicyProduct("toString")).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("keeps paths inside the app", () => {
    expect(safeNextPath("/leads/12?view=cards#notes")).toBe("/leads/12?view=cards#notes");
    expect(safeNextPath("/my-day")).toBe("/my-day");
  });

  it.each(["//evil.com", "/\\evil.com", "/\\/evil.com", "https://evil.com", "evil.com", "javascript:alert(1)", "/login", "/login?next=/x", "", null, undefined])(
    "sends %j to My Day",
    (next) => {
      expect(safeNextPath(next)).toBe("/my-day");
    },
  );
});
