// Gap reports from Capitup AI (capitupindia.com) are Markdown written by a
// model. This is the office's own small Markdown subset, ported as is: it
// builds plain data, never HTML, so a report cannot inject markup.

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "cite"; label: string };

export type Block =
  | { t: "h"; level: 2 | 3 | 4; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; start: number; items: Inline[][] }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "quote"; c: Inline[] }
  | { t: "hr" };

const CITE = /\[(Pages?\s+\d+(?:\s*(?:[-–,]|and)\s*(?:Pages?\s+)?\d+)*)\]/;
const TOKEN = new RegExp(
  `(${CITE.source.replace("(Pages?", "(?:Pages?")}|\\*\\*[^*]+\\*\\*|__[^_]+__|\`[^\`]+\`|\\*[^*\\s][^*]*\\*)`,
  "g",
);

export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  for (const part of text.split(TOKEN)) {
    if (!part) continue;
    const cite = part.match(new RegExp("^" + CITE.source + "$"));
    if (cite) out.push({ t: "cite", label: cite[1].replace(/\s+/g, " ") });
    else if (/^(\*\*|__).+(\*\*|__)$/.test(part) && part.length > 4) out.push({ t: "strong", c: inline(part.slice(2, -2)) });
    else if (/^`.+`$/.test(part)) out.push({ t: "code", v: part.slice(1, -1) });
    else if (/^\*[^*\s].*\*$/.test(part) && part.length > 2) out.push({ t: "em", c: inline(part.slice(1, -1)) });
    else {
      const last = out[out.length - 1];
      if (last?.t === "text") last.v += part;
      else out.push({ t: "text", v: part });
    }
  }
  return out;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => inline(cell.trim()));
const isTableRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ t: "p", c: inline(paragraph.join("\n")) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      flush();
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flush();
      const level = Math.min(4, Math.max(2, heading[1].length + 1)) as 2 | 3 | 4;
      blocks.push({ t: "h", level, c: inline(heading[2].replace(/#+$/, "").trim()) });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flush();
      blocks.push({ t: "hr" });
      continue;
    }
    if (trimmed.includes("|") && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      flush();
      const head = cells(trimmed);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      i--;
      blocks.push({ t: "table", head, rows: rows.map((row) => head.map((_, k) => row[k] || [])) });
      continue;
    }
    const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
    const numbered = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flush();
      const ordered = !!numbered;
      const items: Inline[][] = [];
      const start = numbered ? Number(numbered[1]) : 1;
      while (i < lines.length) {
        const item = lines[i].trim().match(ordered ? /^\d+[.)]\s+(.*)$/ : /^[-*•]\s+(.*)$/);
        if (item) items.push(inline(item[1]));
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1].push({ t: "text", v: " " + lines[i].trim() });
        else break;
        i++;
      }
      i--;
      blocks.push(ordered ? { t: "ol", start, items } : { t: "ul", items });
      continue;
    }
    if (trimmed.startsWith(">")) {
      flush();
      blocks.push({ t: "quote", c: inline(trimmed.replace(/^>\s?/, "")) });
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();
  return blocks;
}

export function plainText(nodes: Inline[]): string {
  return nodes
    .map((node) => (node.t === "text" || node.t === "code" ? node.v : node.t === "cite" ? `[${node.label}]` : plainText(node.c)))
    .join("");
}

export type CellTone = "good" | "info" | "warn" | "risk" | "muted";

// Status and severity words from the assessment prompt get a colour when they fill a cell.
const TONES: Record<string, CellTone> = {
  "explicitly stated": "good",
  ok: "good",
  "calculated from extracted values": "info",
  low: "info",
  "inferred — requires verification": "warn",
  "inferred - requires verification": "warn",
  "awaiting insurer confirmation": "warn",
  medium: "warn",
  "needs review": "warn",
  "conflicting information": "risk",
  high: "risk",
  "not found in supplied documents": "muted",
  "not applicable": "muted",
};

export function cellTone(nodes: Inline[]): CellTone | undefined {
  return TONES[plainText(nodes).replace(/\*/g, "").trim().toLowerCase()];
}

/** The report without the machine-readable ```summary / ```contact blocks. */
export function stripSummary(content: string): string {
  return content
    .replace(/```summary\s*\n[\s\S]*?```/, "")
    .replace(/```contact\s*\n[\s\S]*?```/, "")
    .replace(/```(summary|contact)[\s\S]*$/, "")
    .trimEnd();
}

// Notices the site shows a visitor that are not model answers.
const SERVICE_PREFIXES = [
  "Policy analysis is not available yet.",
  "This document cannot be analysed automatically.",
  "Analysis was interrupted",
  "The previous analysis was interrupted.",
  "Your policy is still being read",
];

/** A gap report opens with a heading or holds the gap table; short replies are not reports. */
export function isReport(content: unknown): boolean {
  const body = String(content ?? "").trimStart();
  if (SERVICE_PREFIXES.some((p) => body.startsWith(p))) return false;
  return body.startsWith("#") || /^\s*\|\s*\**\s*(HIGH|MEDIUM|LOW|OK)\b/im.test(body);
}
