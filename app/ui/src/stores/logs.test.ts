import { describe, expect, it } from "vitest";
import type { LogEvent } from "@/bindings";
import { keepValidPages, PAGE_SIZE } from "./logs";

const pages = () =>
  new Map<number, LogEvent[]>([
    [0, []],
    [1, []],
    [2, []],
  ]);

describe("keepValidPages", () => {
  it("keeps pages before the first changed row", () => {
    const kept = keepValidPages(pages(), { firstChanged: PAGE_SIZE * 2 + 5, evicted: 0 });
    expect([...kept.keys()]).toEqual([0, 1]);
  });

  it("drops everything after an eviction (all indices shifted)", () => {
    expect(keepValidPages(pages(), { firstChanged: null, evicted: 3 }).size).toBe(0);
  });

  it("keeps all pages when no row changed", () => {
    expect(keepValidPages(pages(), { firstChanged: null, evicted: 0 }).size).toBe(3);
  });
});
