// Maps the Android app's Firebase Realtime Database export onto the web schema.
//
// Pure functions only: no file or network access, so the rules are easy to test.
// Field rules follow spec/parity-spec.md §3 and §12 and the schema in
// supabase/migrations. Anything that cannot be carried over cleanly is kept
// (usually appended to the lead's notes) and reported as a flag; nothing is
// silently dropped.

export const STATUS_MAP = {
  prospect: "Prospect",
  quoted: "Quoted",
  "active client": "Active Client",
  "follow-up": "Follow-up",
  "follow up": "Follow-up",
  followup: "Follow-up",
  "closed won": "Closed Won",
  "closed lost": "Closed Lost",
  // Decided by Ash (2026-10-05): the old app's extra statuses.
  pending: "Follow-up",
  contacted: "Follow-up",
  converted: "Closed Won",
};

const PRODUCTS = ["Health", "Fire or Property", "Life", "Motor", "Liability", "Travel", "Marine", "Credit"];

const PRODUCT_SYNONYMS = [
  [/^(fire|property|fire\s*(or|and|&|\/)\s*property)$/i, "Fire or Property"],
  [/^(mediclaim|health\s*insurance)$/i, "Health"],
  [/^(motor|vehicle|car)\s*(insurance)?$/i, "Motor"],
  [/^life\s*(insurance)?$/i, "Life"],
];

// Mirrors public.normalize_company_name() in the core schema migration.
export function normalizeCompanyName(name) {
  const lowered = String(name ?? "").toLowerCase();
  const normalized = lowered
    .replaceAll("&", " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(pvt|private|ltd|limited|llp|llc|inc|incorporated|corp|corporation|plc)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || lowered.trim();
}

// Column headers that the old bulk import saved as if they were companies.
const HEADER_NAMES = new Set(["client_name", "clientname", "client name", "company", "company name", "company_name", "name"]);

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/i;
const NOTE_LINE_RE = /^\[(.+?) - (.+?)\]: (.*)$/;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const str = (v) => (v === null || v === undefined ? "" : String(v)).replace(/\u0000/g, "").trim();
const pad = (n) => String(n).padStart(2, "0");

// Firebase turns maps with small integer keys into arrays with null holes.
export function entriesOf(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) {
    return node.map((v, i) => [String(i), v]).filter(([, v]) => v && typeof v === "object");
  }
  return Object.entries(node).filter(([, v]) => v && typeof v === "object");
}

function isValidDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Accepts the app's "YYYY-MM-DD" / "YYYY-MM-DD HH:mm" plus common hand-typed
// forms (DD-MM-YYYY, DD/MM/YYYY, YYYY/MM/DD). Returns { date, time } or null.
export function parseAppDate(raw) {
  const s = str(raw);
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  let y, mo, d;
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else {
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (!m) return null;
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  if (!isValidDate(y, mo, d)) return null;
  const time = m[4] !== undefined ? `${pad(m[4])}:${m[5]}` : null;
  if (time && (Number(m[4]) > 23 || Number(m[5]) > 59)) return null;
  return { date: `${y}-${pad(mo)}-${pad(d)}`, time };
}

// "05 Oct 2026, 14:30" written in the device's local time; the team is in India.
export function parseNoteTimestamp(raw) {
  const m = str(raw).match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4}),? (\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  const [d, y, h, min] = [Number(m[1]), Number(m[3]), Number(m[4]), Number(m[5])];
  if (!mo || !isValidDate(y, mo, d) || h > 23 || min > 59) return null;
  return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(min)}:00+05:30`;
}

function msToIso(raw) {
  const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  const dt = new Date(n < 1e12 ? n * 1000 : n);
  const y = dt.getUTCFullYear();
  if (y < 2000 || y > 2100) return null;
  return dt.toISOString();
}

function mapProduct(raw) {
  const s = str(raw);
  if (!s) return null;
  const exact = PRODUCTS.find((p) => p.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  for (const [re, product] of PRODUCT_SYNONYMS) if (re.test(s)) return product;
  return null;
}

// Splits "a, b / c" contact lists and keeps the first value that fits.
function splitList(raw) {
  return str(raw)
    .split(/[,;/\n]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function mapPhone(raw, label, extras, flags) {
  const s = str(raw);
  if (s.length <= 32) return s;
  const first = splitList(s)[0] ?? "";
  extras.push(`${label} phone(s): ${s}`);
  flags.push(`${label} phone was longer than 32 characters; kept "${first.slice(0, 32)}", full value moved to notes`);
  return first.slice(0, 32);
}

function mapEmail(raw, label, extras, flags) {
  const s = str(raw).toLowerCase();
  if (!s || EMAIL_RE.test(s)) return s;
  const parts = splitList(s);
  const valid = parts.find((p) => EMAIL_RE.test(p)) ?? "";
  extras.push(`${label} email(s): ${str(raw)}`);
  flags.push(
    valid
      ? `${label} email held several values; kept "${valid}", full value moved to notes`
      : `${label} email "${str(raw)}" is not a valid address; moved to notes`,
  );
  return valid;
}

function fit(value, max, label, flags) {
  if (value.length <= max) return value;
  flags.push(`${label} was longer than ${max} characters and was shortened`);
  return value.slice(0, max);
}

function agentKey(name) {
  return str(name).toLowerCase().replace(/\s+/g, " ");
}

/**
 * @param {object} input
 * @param {object|Array} input.leads    Firebase /leads node
 * @param {object|Array} [input.events] Firebase /events node
 * @param {string[]} [input.userNames]  Keys of /users only (never the values)
 * @param {Record<string,string>} [input.agentEmails] agent display name -> login email
 */
export function transform({ leads, events, userNames = [], agentEmails = {} }) {
  const emailByAgent = new Map(Object.entries(agentEmails).map(([n, e]) => [agentKey(n), str(e).toLowerCase()]));
  const agentsSeen = new Map(); // key -> { name, leads, notes, fromUsers }
  const seeAgent = (name, field) => {
    const key = agentKey(name);
    if (!key || key === "unassigned") return null;
    if (!agentsSeen.has(key)) agentsSeen.set(key, { name: str(name), leads: 0, notes: 0, fromUsers: false, spellings: new Map() });
    const agent = agentsSeen.get(key);
    if (field) {
      agent[field] += 1;
      // Show the spelling used most on leads and notes ("Sravani"), not the /users login ("sravani").
      agent.spellings.set(str(name), (agent.spellings.get(str(name)) ?? 0) + 1);
      agent.name = [...agent.spellings].sort((a, b) => b[1] - a[1])[0][0];
    }
    return key;
  };
  for (const u of userNames) {
    const key = seeAgent(u);
    if (key) agentsSeen.get(key).fromUsers = true;
  }

  const imported = [];
  const skipped = [];
  const stats = { renewalTimesDropped: 0, missingCreatedAt: 0, visitingCardImagesDropped: 0, notesSplit: 0 };

  const rawLeads = entriesOf(leads)
    .map(([key, l]) => ({ key, l, legacyId: str(l.id) || key, createdAt: msToIso(l.createdAt) }))
    .sort((a, b) => (a.createdAt ?? "9").localeCompare(b.createdAt ?? "9") || a.legacyId.localeCompare(b.legacyId, "en", { numeric: true }));

  const seenLegacyIds = new Set();
  const exactCopies = new Map();

  for (const { l, legacyId, createdAt } of rawLeads) {
    const flags = [];
    const extras = [];
    const clientName = str(l.clientName);

    if (!clientName) {
      skipped.push({ legacyId, clientName: "", reason: "No client name" });
      continue;
    }
    if (HEADER_NAMES.has(clientName.toLowerCase())) {
      skipped.push({ legacyId, clientName, reason: "Spreadsheet header row saved by the old bulk import, not a lead" });
      continue;
    }
    if (seenLegacyIds.has(legacyId)) {
      skipped.push({ legacyId, clientName, reason: `Another record already uses id ${legacyId}` });
      continue;
    }
    seenLegacyIds.add(legacyId);

    // Renewal date (the web stores a date; the due time is a global setting).
    let renewalDate = null;
    const rawDate = str(l.renewalDate);
    if (rawDate) {
      const parsed = parseAppDate(rawDate);
      if (!parsed) {
        extras.push(`Renewal date as entered: ${rawDate}`);
        flags.push(`Renewal date "${rawDate}" could not be read; left empty and kept in notes`);
      } else {
        renewalDate = parsed.date;
        if (parsed.time) stats.renewalTimesDropped += 1;
      }
    }

    // Type
    const rawType = str(l.type);
    let type;
    if (/renew/i.test(rawType)) type = "Renewal";
    else if (/^new$/i.test(rawType)) type = "New";
    else {
      type = renewalDate ? "Renewal" : "New";
      if (rawType) flags.push(`Type "${rawType}" is not New/Renewal; set to ${type}`);
    }

    // Business type
    const rawBiz = str(l.businessType);
    let businessType = "Corporate";
    if (/retail/i.test(rawBiz)) businessType = "Retail";
    else if (rawBiz && !/corp/i.test(rawBiz)) flags.push(`Business type "${rawBiz}" is not Corporate/Retail; set to Corporate`);

    // Product
    let subProduct = str(l.subProductName);
    const rawProduct = str(l.policyProduct);
    let product = mapProduct(rawProduct);
    if (!product) {
      product = "Health";
      if (rawProduct) {
        if (!subProduct) subProduct = rawProduct;
        else extras.push(`Product as entered: ${rawProduct}`);
        flags.push(`Product "${rawProduct}" is not one of the 8 products; set to Health, original kept`);
      } else {
        flags.push("No product; set to Health");
      }
    }

    // Status
    const rawStatus = str(l.status);
    let status = STATUS_MAP[rawStatus.toLowerCase()];
    if (!status) {
      status = "Prospect";
      if (rawStatus) flags.push(`Status "${rawStatus}" is unknown; set to Prospect`);
    }

    // Agent
    const rawAgent = str(l.assignedAgent);
    const agent = seeAgent(rawAgent, "leads");
    const agentEmail = agent ? emailByAgent.get(agent) ?? null : null;

    // Notes: timestamped agent lines become lead_notes, the rest stays as text.
    const leadNotes = [];
    const freeText = [];
    for (const line of str(l.notes).split(/\r?\n/)) {
      const m = line.trim().match(NOTE_LINE_RE);
      const at = m ? parseNoteTimestamp(m[2]) : null;
      const content = m ? m[3].trim() : "";
      if (m && at && content) {
        const noteAgent = seeAgent(m[1], "notes");
        leadNotes.push({
          agentName: str(m[1]).slice(0, 120),
          agentEmail: noteAgent ? emailByAgent.get(noteAgent) ?? null : null,
          content: content.slice(0, 5000),
          createdAt: at,
        });
      } else if (line.trim() || freeText.length) {
        freeText.push(line.replace(/\s+$/, ""));
      }
    }
    stats.notesSplit += leadNotes.length;

    if (str(l.visitingCardImage)) stats.visitingCardImagesDropped += 1;
    if (!createdAt) stats.missingCreatedAt += 1;

    const lead = {
      legacyId,
      clientName: fit(clientName, 300, "Client name", flags),
      type,
      businessType,
      policyProduct: product,
      subProductName: fit(subProduct, 200, "Sub-product", flags),
      renewalDate,
      pocName: fit(str(l.pocName), 120, "POC name", flags),
      pocDesignation: fit(str(l.pocDesignation), 120, "POC designation", flags),
      pocContactNumber: mapPhone(l.pocContactNumber, "POC", extras, flags),
      pocEmailId: mapEmail(l.pocEmailId, "POC", extras, flags),
      poc2Name: fit(str(l.poc2Name), 120, "POC 2 name", flags),
      poc2Designation: fit(str(l.poc2Designation), 120, "POC 2 designation", flags),
      poc2ContactNumber: mapPhone(l.poc2ContactNumber, "POC 2", extras, flags),
      poc2EmailId: mapEmail(l.poc2EmailId, "POC 2", extras, flags),
      status,
      agentName: rawAgent && agent ? rawAgent : "Unassigned",
      agentEmail,
      createdAt,
      leadNotes,
      notes: "",
      flags,
    };

    const noteParts = [freeText.join("\n").trim()];
    if (extras.length) noteParts.push(`[Imported from the old app]\n${extras.join("\n")}`);
    lead.notes = fit(noteParts.filter(Boolean).join("\n\n"), 20000, "Notes", flags);

    // A record that repeats another one field for field is skipped, not imported twice.
    const fingerprint = JSON.stringify([
      normalizeCompanyName(lead.clientName), lead.type, lead.businessType, lead.policyProduct,
      lead.subProductName.toLowerCase(), lead.renewalDate, lead.pocName.toLowerCase(),
      lead.pocContactNumber, lead.pocEmailId, lead.poc2Name.toLowerCase(), lead.status,
      agentKey(lead.agentName), lead.notes, leadNotes.map((n) => n.content),
    ]);
    if (exactCopies.has(fingerprint)) {
      skipped.push({ legacyId, clientName, reason: `Exact copy of record ${exactCopies.get(fingerprint)}` });
      continue;
    }
    exactCopies.set(fingerprint, legacyId);

    imported.push(lead);
  }

  // Duplicate companies: the database flags these on insert; listed here so the
  // admin can resolve them after the import.
  const byCompany = new Map();
  for (const lead of imported) {
    const key = normalizeCompanyName(lead.clientName);
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(lead);
  }
  const duplicateGroups = [...byCompany.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({
      company: g[0].clientName,
      leads: g.map((l) => ({ legacyId: l.legacyId, clientName: l.clientName, agentName: l.agentName })),
    }));

  // Events: renewal reminders are regenerated by the database from each lead's
  // renewal date, so only events people created by hand are carried over.
  const leadIds = new Set(imported.map((l) => l.legacyId));
  const importedEvents = [];
  const skippedEvents = { systemGenerated: 0, orphaned: 0, unreadableDate: 0, noTitle: 0 };
  for (const [key, e] of entriesOf(events)) {
    if (e.isSystemGenerated === true || e.isBackgroundReminder === true || e.isSystemGenerated === "true") {
      skippedEvents.systemGenerated += 1;
      continue;
    }
    const title = str(e.title).slice(0, 300);
    if (!title) {
      skippedEvents.noTitle += 1;
      continue;
    }
    const leadLegacyId = str(e.leadId);
    if (leadLegacyId && leadLegacyId !== "0" && !leadIds.has(leadLegacyId)) {
      skippedEvents.orphaned += 1;
      continue;
    }
    const when = parseAppDate(e.date);
    if (!when) {
      skippedEvents.unreadableDate += 1;
      continue;
    }
    const agent = seeAgent(e.assignedAgent);
    importedEvents.push({
      legacyId: str(e.id) || key,
      leadLegacyId: leadLegacyId && leadLegacyId !== "0" ? leadLegacyId : null,
      title,
      // Date-only events are placed at 10:00 IST, the default renewal due time.
      eventTimestamp: `${when.date} ${when.time ?? "10:00"}:00+05:30`,
      notes: str(e.notes).slice(0, 5000),
      isCompleted: e.isCompleted === true || e.isCompleted === "true",
      agentEmail: agent ? emailByAgent.get(agent) ?? null : null,
      createdAt: msToIso(e.createdAt),
    });
  }

  const agents = [...agentsSeen.values()]
    .map((a) => ({
      name: a.name,
      leads: a.leads,
      notes: a.notes,
      fromUsers: a.fromUsers,
      email: emailByAgent.get(agentKey(a.name)) ?? null,
    }))
    .sort((a, b) => b.leads - a.leads || a.name.localeCompare(b.name));

  return { imported, skipped, duplicateGroups, events: importedEvents, skippedEvents, agents, stats };
}
