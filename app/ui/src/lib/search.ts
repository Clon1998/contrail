/**
 * Search for the profile switcher and the service palette (a cmdk `filter`): every
 * whitespace-separated word must occur in the item's value or keywords, case-insensitively.
 * Substring matching instead of cmdk's default fuzzy matching, which would match names and
 * account IDs whose characters merely appear in order.
 */
export function matchWords(value: string, search: string, keywords: string[] = []): number {
  const haystack = [value, ...keywords].join(" ").toLowerCase();
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((word) => haystack.includes(word)) ? 1 : 0;
}
