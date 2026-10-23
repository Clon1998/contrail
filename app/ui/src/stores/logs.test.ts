import { describe, expect, it } from "vitest";
import type { LogEvent } from "@/bindings";
import { applyLiveRows, isPageComplete, mergeFetchedRows, PAGE_SIZE, placeOlderRows } from "./logs";

const pages = () =>
  new Map<number, LogEvent[]>([
    [0, []],
    [1, []],
    [2, []],
  ]);

describe("applyLiveRows", () => {
  const row = (seq: number) => ({ seq }) as LogEvent;
  const full = (page: number) =>
    Array.from({ length: PAGE_SIZE }, (_, i) => row(page * PAGE_SIZE + i));
  const seqs = (pages: Map<number, LogEvent[]>, page: number) => pages.get(page)?.map((e) => e.seq);

  it("keeps pages before the first changed row, and the unchanged rows of its page", () => {
    const loaded = new Map([0, 1, 2, 3].map((page) => [page, full(page)]));
    const kept = applyLiveRows(loaded, { firstChanged: PAGE_SIZE * 2 + 5, evicted: 0, rows: [] });
    expect([...kept.keys()]).toEqual([0, 1, 2]);
    // Rows still on screen stay rendered (an expanded row doesn't flicker) until the refetch.
    expect(seqs(kept, 2)).toEqual([200, 201, 202, 203, 204]);
    expect(kept.get(1)).toBe(loaded.get(1));
  });

  it("puts the rows that came with the update in place, so new rows need no fetch", () => {
    const loaded = new Map([[0, full(0).slice(0, 98)]]);
    const next = applyLiveRows(loaded, {
      firstChanged: 98,
      evicted: 0,
      rows: [row(1098), row(1099), row(1100)],
    });
    expect(seqs(next, 0)?.slice(-2)).toEqual([1098, 1099]);
    expect(seqs(next, 1)).toEqual([1100]);
    expect(loaded.get(0)).toHaveLength(98); // the previous state is not changed
  });

  it("shifts the cached rows after an eviction instead of dropping them", () => {
    const loaded = new Map([0, 1].map((page) => [page, full(page)]));
    const next = applyLiveRows(loaded, {
      firstChanged: 2 * PAGE_SIZE - 3,
      evicted: 3,
      rows: [row(900), row(901), row(902)],
    });
    expect(seqs(next, 0)?.slice(0, 2)).toEqual([3, 4]);
    expect(seqs(next, 1)?.slice(-4)).toEqual([199, 900, 901, 902]);
    expect(next.get(1)).toHaveLength(PAGE_SIZE);
  });

  it("keeps all pages when no row changed", () => {
    expect(applyLiveRows(pages(), { firstChanged: null, evicted: 0, rows: [] }).size).toBe(3);
  });
});

describe("placeOlderRows", () => {
  const row = (seq: number) => ({ seq }) as LogEvent;
  const full = (page: number) =>
    Array.from({ length: PAGE_SIZE }, (_, i) => row(1000 + page * PAGE_SIZE + i));

  it("moves the cached rows behind the older ones and fills in the rows that came along", () => {
    const loaded = new Map([0, 1, 2].map((page) => [page, full(page)]));
    // 250 older rows in front; the result carries listed rows 150..549.
    const rows = Array.from({ length: 400 }, (_, i) => row(i < 100 ? 150 + i : 1000 + i - 100));
    const next = placeOlderRows(loaded, { added: 250, rowsFrom: 150, rows });
    // Page 1 (rows 100..199) starts before the rows that came along: left for a fetch.
    expect(next.has(1)).toBe(false);
    // Page 2 holds the newest older rows, then the previous first rows.
    expect(next.get(2)?.[49]?.seq).toBe(249);
    expect(next.get(2)?.[50]?.seq).toBe(1000);
    // The rest of the cache moved by 250 (row 1000 + 299 was at 299, now at 549).
    expect(next.get(5)?.[49]?.seq).toBe(1299);
    expect(loaded.get(0)?.[0]?.seq).toBe(1000); // the previous state is not changed
  });
});

describe("mergeFetchedRows", () => {
  const row = (seq: number) => ({ seq }) as LogEvent;
  const page = (first: number) => Array.from({ length: PAGE_SIZE }, (_, i) => row(first + i));

  it("keeps a fetched page whose rows didn't change while it was in flight", () => {
    const next = mergeFetchedRows(new Map(), 1, page(100), { shift: 0, valid: Infinity });
    expect(next.get(1)).toHaveLength(PAGE_SIZE);
  });

  it("moves the rows by what was evicted meanwhile and drops the changed ones", () => {
    const before = new Map([[0, page(0)]]);
    // Page 1 was fetched; meanwhile 30 rows were evicted and rows from 150 on changed.
    const next = mergeFetchedRows(before, 1, page(100), { shift: 30, valid: 150 });
    expect(next.get(0)?.[70]?.seq).toBe(100); // row 100 is now at 70
    expect(next.get(1)?.at(-1)?.seq).toBe(179); // row 179 at 149; 150+ changed
    expect(next.get(1)).toHaveLength(50);
    expect(before.get(0)?.[70]?.seq).toBe(70); // the previous state is not changed
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
