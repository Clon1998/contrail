import type { SearchEntry, SearchHistory } from "@/bindings";

/** The same search: query and how it is read. */
export function sameSearch(a: SearchEntry, b: SearchEntry): boolean {
  return a.query === b.query && a.regex === b.regex && a.raw === b.raw;
}

/**
 * The searches the arrow keys step through in a service's search box, newest first: the
 * service's own, then the ones run in other services (each search once).
 */
export function recallList(history: SearchHistory, serviceKey: string): SearchEntry[] {
  const own = history.perService[serviceKey] ?? [];
  return [...own, ...history.global.filter((g) => !own.some((o) => sameSearch(o, g)))];
}
