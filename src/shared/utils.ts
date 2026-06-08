/**
 * Extract the first numeric value from a free-text price string.
 * Handles forms like "Above 7446", "7438-7443", "7431.5 first, then 7425".
 * Returns null when no number is found.
 */
export function parsePrice(text: string): number | null {
  const match = text.match(/\d+\.?\d*/);
  if (!match) return null;
  const n = parseFloat(match[0]);
  return isNaN(n) ? null : n;
}
