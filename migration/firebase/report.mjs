// Human-readable dry-run report. Contains company and contact names (the data
// being migrated) but never anything from /users beyond the user names.

const esc = (s) => String(s ?? "").replaceAll("|", "\\|").replace(/\s+/g, " ").trim();

function countBy(items, key) {
  const m = new Map();
  for (const it of items) m.set(it[key], (m.get(it[key]) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export function buildReport(result, { sourceLabel, generatedAt }) {
  const { imported, skipped, duplicateGroups, events, skippedEvents, calendarMismatches = [], calendarOrphans = 0, agents, stats } =
    result;
  const flagged = imported.filter((l) => l.flags.length);
  const notes = imported.reduce((n, l) => n + l.leadNotes.length, 0);
  const withDates = imported.filter((l) => l.renewalDate).length;
  const L = [];

  L.push("# Firebase import dry run");
  L.push("");
  L.push(`Source: ${sourceLabel}. Generated ${generatedAt}. Nothing has been written to any database.`);
  L.push("");
  L.push("## Summary");
  L.push("");
  L.push("| | Count |");
  L.push("| --- | ---: |");
  L.push(`| Leads that would be imported | ${imported.length} |`);
  L.push(`| of which flagged for a look | ${flagged.length} |`);
  L.push(`| Leads skipped | ${skipped.length} |`);
  L.push(`| Companies with more than one lead (flagged as duplicates by the database) | ${duplicateGroups.length} |`);
  L.push(`| Agent notes split into the notes timeline | ${notes} |`);
  L.push(`| Leads with a renewal date (reminders regenerated) | ${withDates} |`);
  L.push(`| Hand-made calendar events imported | ${events.length} |`);
  L.push(`| Old renewal reminders skipped (regenerated from renewal dates instead) | ${skippedEvents.systemGenerated} |`);
  L.push(`| Old calendar entries naming a different client (kept in notes) | ${calendarMismatches.length} |`);
  const otherEventSkips = skippedEvents.orphaned + skippedEvents.unreadableDate + skippedEvents.noTitle;
  if (otherEventSkips) {
    L.push(
      `| Other events skipped (lead missing ${skippedEvents.orphaned}, unreadable date ${skippedEvents.unreadableDate}, no title ${skippedEvents.noTitle}) | ${otherEventSkips} |`,
    );
  }
  L.push("");
  const cutoff = new Date(Date.parse(generatedAt) - 30 * 86400000).toISOString().slice(0, 10);
  const longPast = imported.filter((l) => l.renewalDate && l.renewalDate < cutoff).length;
  if (longPast) {
    L.push(`${longPast} renewal dates are more than 30 days past. Their due tasks are imported as done so they do not bury today's work on My Day; the leads keep their dates, so analytics still counts them as overdue renewals.`);
    L.push("");
  }
  if (stats.renewalTimesDropped) {
    L.push(`${stats.renewalTimesDropped} renewal dates carried a time of day; the web app keeps the date and uses the configured due time (10:00 IST).`);
    L.push("");
  }
  if (stats.missingCreatedAt) {
    L.push(`${stats.missingCreatedAt} leads had no creation time; they get the import time.`);
    L.push("");
  }
  if (stats.visitingCardImagesDropped) {
    L.push(`${stats.visitingCardImagesDropped} leads carried a visiting card image; images are not imported (re-upload them in the web app).`);
    L.push("");
  }

  L.push("## Status mapping");
  L.push("");
  L.push("| New status | Leads |");
  L.push("| --- | ---: |");
  for (const [status, n] of countBy(imported, "status")) L.push(`| ${status} | ${n} |`);
  L.push("");
  L.push("Pending and Contacted became Follow-up; Converted became Closed Won.");
  L.push("");

  L.push("## Agents");
  L.push("");
  L.push("When the import runs, each agent is matched to the web account with the same full name (or the email given in `agents.json`).");
  L.push("The old app's Admin login maps to the web admin account when no account is called Admin and there is exactly one active admin.");
  L.push("If an agent who owns leads has no account, the import stops before writing anything. `check.sql` shows the matches beforehand.");
  L.push("");
  L.push("| Agent in the old app | Leads | Notes written | Events | Web account |");
  L.push("| --- | ---: | ---: | ---: | --- |");
  const matchText = (a) =>
    a.match === "email"
      ? esc(a.email)
      : a.match === "unassigned"
        ? "Unassigned (by choice)"
        : `${a.required ? "**needed**" : "optional"}, matched by full name${a.key === "admin" ? " or the admin account" : ""}`;
  for (const a of agents) {
    L.push(`| ${esc(a.name)} | ${a.leads} | ${a.notes} | ${a.events} | ${matchText(a)} |`);
  }
  L.push("");

  if (calendarMismatches.length) {
    L.push("## Old calendar entries that name a different client");
    L.push("");
    L.push("The old app reused record ids across phones, so a lead could be overwritten by another while its calendar entry kept the original client.");
    L.push("These entries are added to the notes of the lead that now holds the record. Check whether the client in the calendar needs its own lead.");
    L.push("");
    L.push("| Old id | Lead now | Calendar entry | Date | Details |");
    L.push("| --- | --- | --- | --- | --- |");
    for (const c of calendarMismatches) {
      L.push(`| ${esc(c.legacyId)} | ${esc(c.clientName)} | ${esc(c.title)} | ${esc(c.date)} | ${esc(c.notes)} |`);
    }
    L.push("");
  }
  if (calendarOrphans) {
    L.push(`Old calendar entries for ${calendarOrphans} leads that are no longer in the export (deleted in the old app) are not imported.`);
    L.push("");
  }

  if (duplicateGroups.length) {
    L.push("## Duplicate companies");
    L.push("");
    L.push("These are imported, and the database marks every lead after the first as a duplicate so an admin can resolve them on the Duplicates page.");
    L.push("");
    L.push("| Company | Leads (old id, agent) |");
    L.push("| --- | --- |");
    for (const g of duplicateGroups) {
      L.push(`| ${esc(g.company)} | ${g.leads.map((l) => `${esc(l.clientName)} (#${esc(l.legacyId)}, ${esc(l.agentName)})`).join("; ")} |`);
    }
    L.push("");
  }

  if (skipped.length) {
    L.push("## Skipped leads");
    L.push("");
    L.push("| Old id | Client | Reason |");
    L.push("| --- | --- | --- |");
    for (const s of skipped) L.push(`| ${esc(s.legacyId)} | ${esc(s.clientName) || "(blank)"} | ${esc(s.reason)} |`);
    L.push("");
  }

  if (flagged.length) {
    L.push("## Flagged leads");
    L.push("");
    L.push("Imported, but something was adjusted. Original values are kept in the lead's notes where relevant.");
    L.push("");
    L.push("| Old id | Client | What changed |");
    L.push("| --- | --- | --- |");
    for (const l of flagged) L.push(`| ${esc(l.legacyId)} | ${esc(l.clientName)} | ${l.flags.map(esc).join("; ")} |`);
    L.push("");
  }

  return L.join("\n");
}
