/** A piece of text and whether it matched a search term. */
export interface Segment {
  text: string;
  match: boolean;
}

/** Splits `text` at case-insensitive occurrences of any of `terms` (longest term first). */
export function highlightSegments(text: string, terms: string[]): Segment[] {
  const needles = terms.filter((t) => t.length > 0).map((t) => t.toLowerCase());
  if (needles.length === 0) return [{ text, match: false }];
  needles.sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  const segments: Segment[] = [];
  let plainStart = 0;
  let i = 0;
  while (i < text.length) {
    const needle = needles.find((n) => lower.startsWith(n, i));
    if (needle) {
      if (i > plainStart) segments.push({ text: text.slice(plainStart, i), match: false });
      segments.push({ text: text.slice(i, i + needle.length), match: true });
      i += needle.length;
      plainStart = i;
    } else {
      i++;
    }
  }
  if (plainStart < text.length) segments.push({ text: text.slice(plainStart), match: false });
  return segments;
}

/** A search term for `key:value`, quoting the value when it contains spaces or quotes. */
export function fieldTerm(key: string, value: string): string {
  return /[\s"]/.test(value)
    ? `${key}:"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : `${key}:${value}`;
}

/** Adds a term to a query (unless it's already there). */
export function appendTerm(query: string, term: string): string {
  const trimmed = query.trim();
  if (trimmed.split(/\s+/).includes(term)) return trimmed;
  return trimmed ? `${trimmed} ${term}` : term;
}
