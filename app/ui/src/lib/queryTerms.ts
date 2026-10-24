/**
 * Adding and removing search terms by click (the Fields panel), on the query text itself. Terms
 * are split like the Rust query parser does: at whitespace outside quotes and `/regex/`.
 */

/** The terms of a query, as written. */
export function splitTerms(query: string): string[] {
  const terms: string[] = [];
  let current = "";
  let quote: '"' | "/" | null = null;
  for (let i = 0; i < query.length; i++) {
    const c = query.charAt(i);
    if (quote) {
      current += c;
      if (c === "\\" && i + 1 < query.length) {
        current += query.charAt(++i);
      } else if (c === quote) {
        quote = null;
      }
    } else if (/\s/.test(c)) {
      if (current) terms.push(current);
      current = "";
    } else {
      // A quote may start a term or follow `key:`; a regex only starts a term (or after `-`).
      if (c === '"' || (c === "/" && (current === "" || current === "-"))) quote = c;
      current += c;
    }
  }
  if (current) terms.push(current);
  return terms;
}

/** A value as the query parser reads it back: quoted when it has spaces, quotes or is empty. */
export function quoteValue(value: string): string {
  if (value !== "" && !/[\s"\\]/.test(value) && !value.startsWith("/")) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** `key:value`, or `-key:value` to exclude. */
export function fieldTerm(key: string, value: string, exclude = false): string {
  return `${exclude ? "-" : ""}${key}:${quoteValue(value)}`;
}

/** A phrase term (text in the message). */
export function phraseTerm(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether the query has this term (any case, as the search compares values). */
export function hasTerm(query: string, term: string): boolean {
  return splitTerms(query).some((t) => same(t, term));
}

/** The term without a leading `-`. */
function positive(term: string): string {
  return term.startsWith("-") ? term.slice(1) : term;
}

/**
 * Adds `term`, or removes it when the query has it already. Its opposite (`-term` for `term` and
 * the other way round) goes away either way: a value can't be both wanted and excluded.
 */
export function toggleTerm(query: string, term: string): string {
  const terms = splitTerms(query);
  const present = terms.some((t) => same(t, term));
  const rest = terms.filter((t) => !same(positive(t), positive(term)));
  return (present ? rest : [...rest, term]).join(" ");
}

/**
 * Sets the only term of a kind (`state:`, `topic:`, `correlation:`): replaces any other term with
 * the same `prefix`, or with `null` removes them all.
 */
export function replaceTerm(query: string, prefix: string, term: string | null): string {
  const rest = splitTerms(query).filter(
    (t) => !positive(t).toLowerCase().startsWith(prefix.toLowerCase()),
  );
  return (term ? [...rest, term] : rest).join(" ");
}

/** The value of the (not excluded) term with this prefix, e.g. `FAILED` for `state:`. */
export function termValue(query: string, prefix: string): string | null {
  const term = splitTerms(query).find((t) => t.toLowerCase().startsWith(prefix.toLowerCase()));
  if (!term) return null;
  return unquote(term.slice(prefix.length));
}

function unquote(value: string): string {
  if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) return value;
  return value.slice(1, -1).replace(/\\(.)/g, "$1");
}
