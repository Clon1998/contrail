import { describe, expect, it } from "vitest";
import type { Timeline } from "@/bindings";
import {
  bucketRange,
  rangePixels,
  selectionRange,
  timelineLabel,
  utcOffsetMinutes,
} from "./timeline";

const empty = { error: 0, warn: 0, info: 0, debug: 0, trace: 0, none: 0 };
const timeline: Timeline = {
  start: "2026-10-26T12:00:00.000Z",
  bucketMs: 60_000,
  buckets: Array.from({ length: 10 }, () => empty),
};

describe("timeline", () => {
  it("knows each bucket's time range", () => {
    expect(bucketRange(timeline, 2).map((ms) => new Date(ms).toISOString())).toEqual([
      "2026-10-26T12:02:00.000Z",
      "2026-10-26T12:03:00.000Z",
    ]);
  });

  it("turns a drag into the range of the bars under it, in either direction", () => {
    // 100 px wide, 10 buckets: x 25..44 covers buckets 2..4.
    const range = { start: "2026-10-26T12:02:00.000Z", end: "2026-10-26T12:05:00.000Z" };
    expect(selectionRange(timeline, 25, 44, 100)).toEqual(range);
    expect(selectionRange(timeline, 44, 25, 100)).toEqual(range);
    // Past the edges: clamped to the first and last bucket.
    expect(selectionRange(timeline, -10, 500, 100)).toEqual({
      start: "2026-10-26T12:00:00.000Z",
      end: "2026-10-26T12:10:00.000Z",
    });
    // A click: the bar under it.
    expect(selectionRange(timeline, 31, 31, 100)).toEqual({
      start: "2026-10-26T12:03:00.000Z",
      end: "2026-10-26T12:04:00.000Z",
    });
  });

  it("places a range on the chart, clamped to its edges", () => {
    const range = { start: "2026-10-26T12:02:00.000Z", end: "2026-10-26T12:05:00.000Z" };
    expect(rangePixels(timeline, range, 100)).toEqual({ left: 20, width: 30 });
    const wider = { start: "2026-10-26T11:00:00.000Z", end: "2026-10-26T12:03:00.000Z" };
    expect(rangePixels(timeline, wider, 100)).toEqual({ left: 0, width: 30 });
  });

  it("labels times in the zone shown", () => {
    const ms = Date.parse("2026-10-26T12:05:00Z");
    expect(timelineLabel(ms, "utc", false)).toBe("12:05");
    expect(timelineLabel(ms + 30_000, "utc", false)).toBe("12:05:30");
    expect(timelineLabel(ms, "utc", true)).toBe("2026-10-26 12:05");
    expect(utcOffsetMinutes("utc")).toBe(0);
    expect(utcOffsetMinutes("local", new Date("2026-10-26T12:00:00Z"))).toBe(
      -new Date("2026-10-26T12:00:00Z").getTimezoneOffset(),
    );
  });
});
