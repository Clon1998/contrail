import { describe, expect, it } from "vitest";
import type { LogEvent } from "@/bindings";
import { isPageComplete, keepValidPages, PAGE_SIZE } from "./logs";

const pages = () =>
  new Map<number, LogEvent[]>([
    [0, []],
    [1, []],
    [2, []],
  ]);

describe("keepValidPages", () => {
  it("keeps pages before the first changed row, and the unchanged rows of its page", () => {
    const full = (page: number) =>
      Array.from({ length: PAGE_SIZE }, (_, i) => ({ seq: page * PAGE_SIZE + i }) as LogEvent);
    const loaded = new Map([0, 1, 2, 3].map((page) => [page, full(page)]));
    const kept = keepValidPages(loaded, { firstChanged: PAGE_SIZE * 2 + 5, evicted: 0 });
    expect([...kept.keys()]).toEqual([0, 1, 2]);
    // Rows still on screen stay rendered (an expanded row doesn't flicker) until the refetch.
    expect(kept.get(2)?.map((e) => e.seq)).toEqual([200, 201, 202, 203, 204]);
    expect(kept.get(1)).toBe(loaded.get(1));
  });

  it("drops everything after an eviction (all indices shifted)", () => {
    expect(keepValidPages(pages(), { firstChanged: null, evicted: 3 }).size).toBe(0);
  });

  it("keeps all pages when no row changed", () => {
    expect(keepValidPages(pages(), { firstChanged: null, evicted: 0 }).size).toBe(3);
  });
});

describe("isPageComplete", () => {
  const rows = (n: number) => Array.from({ length: n }, () => ({}) as LogEvent);
  it("needs every listed row of the page", () => {
    expect(isPageComplete(undefined, 0, 50)).toBe(false);
    expect(isPageComplete(rows(PAGE_SIZE), 0, 500)).toBe(true);
    expect(isPageComplete(rows(5), 2, 500)).toBe(false);
    // The last page holds only the rest.
    expect(isPageComplete(rows(20), 4, 4 * PAGE_SIZE + 20)).toBe(true);
    expect(isPageComplete(rows(20), 4, 4 * PAGE_SIZE + 21)).toBe(false);
  });
});
