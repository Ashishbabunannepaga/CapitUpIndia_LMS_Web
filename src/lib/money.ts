/**
 * Rupee amounts as people type them: "1,25,000", "₹ 1,25,000", "Rs. 1,25,000/-",
 * "INR 125000.50". Returns the bare number text ("125000.50"), or the input
 * with only the symbols removed when it isn't an amount, so callers can show
 * their own error.
 */
export function cleanInr(text: string): string {
  return text
    .trim()
    .replace(/^(₹|rs\.?|inr)\s*/i, "")
    .replace(/\s*(\/-|\/=|rs\.?|inr|₹)$/i, "")
    .replace(/[₹,\s]/g, "");
}

/** The amount in rupees, or null when the text is empty or not an amount. */
export function parseInr(text: string): number | null {
  const clean = cleanInr(text);
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}
