/** ISO 3166-1 alpha-2 country code (uppercase) → flag emoji.
 *  Returns "" for null/empty/non-2-letter input rather than throwing. */
export function countryFlag(code: string | null | undefined): string {
  if (!code || code.length !== 2) return "";
  const upper = code.toUpperCase();
  const a = upper.charCodeAt(0);
  const b = upper.charCodeAt(1);
  if (a < 65 || a > 90 || b < 65 || b > 90) return "";
  return String.fromCodePoint(0x1f1e6 + a - 65, 0x1f1e6 + b - 65);
}
