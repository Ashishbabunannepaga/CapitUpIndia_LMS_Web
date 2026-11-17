/**
 * The old Android app appended a line like "[AI Import Update: Tagged as
 * Prospect]" to a lead's notes every time it re-imported the lead, so some
 * imported leads repeat the same line several times. These helpers drop the
 * repeats (only those bracketed system lines, the first copy stays) for
 * display and when the notes are next saved.
 */
const SYSTEM_LINE = /^\s*\[AI Import Update:[^\]]*\]\s*$/i;

export function isSystemNoteLine(line: string): boolean {
  return SYSTEM_LINE.test(line);
}

export function tidyLeadNotes(notes: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of notes.split(/\r?\n/)) {
    if (isSystemNoteLine(line)) {
      const key = line.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}
