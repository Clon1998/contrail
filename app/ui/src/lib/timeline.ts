import type { TimeRange, Timeline } from "@/bindings";
import { formatClock, formatDate, timeParts, type TimeFormat } from "./timeFormat";

/** Minutes ahead of UTC for the times shown (the timeline aligns hours and days to them). */
export function utcOffsetMinutes(timeZone: "local" | "utc", at = new Date()): number {
  return timeZone === "utc" ? 0 : -at.getTimezoneOffset();
}

/** Start and end (milliseconds) of bucket `index`. */
export function bucketRange(timeline: Timeline, index: number): [number, number] {
  const start = Date.parse(timeline.start) + index * timeline.bucketMs;
  return [start, start + timeline.bucketMs];
}

/**
 * The time range a drag from `x0` to `x1` (pixels, either direction; the same for a click) covers
 * on a timeline drawn `width` pixels wide, widened to whole buckets: the bars under the drag are
 * inside the range.
 */
export function selectionRange(
  timeline: Timeline,
  x0: number,
  x1: number,
  width: number,
): TimeRange {
  const count = timeline.buckets.length;
  const bucketAt = (x: number) => Math.min(count - 1, Math.max(0, Math.floor((x / width) * count)));
  const first = bucketAt(Math.min(x0, x1));
  const last = bucketAt(Math.max(x0, x1));
  return {
    start: new Date(bucketRange(timeline, first)[0]).toISOString(),
    end: new Date(bucketRange(timeline, last)[1]).toISOString(),
  };
}

/** Where `range` lies on a timeline drawn `width` pixels wide: left edge and width, clamped. */
export function rangePixels(
  timeline: Timeline,
  range: TimeRange,
  width: number,
): { left: number; width: number } {
  const start = Date.parse(timeline.start);
  const span = timeline.buckets.length * timeline.bucketMs;
  const x = (iso: string) =>
    Math.min(width, Math.max(0, ((Date.parse(iso) - start) / span) * width));
  const left = x(range.start);
  return { left, width: x(range.end) - left };
}

/**
 * Where the loaded events start on a timeline drawn `width` pixels wide: everything left of it
 * isn't loaded yet (0 when everything is).
 */
export function loadedFromPixel(timeline: Timeline, width: number): number {
  return rangePixels(timeline, { start: timeline.start, end: timeline.loadedFrom }, width).width;
}

/** A label for a time on the timeline: the time of day, with the date when it spans days. */
export function timelineLabel(ms: number, format: TimeFormat, withDate: boolean): string {
  const t = timeParts(ms, format.timeZone);
  const time = formatClock(t, format.clock, { seconds: t.second !== 0 });
  return withDate
    ? `${formatDate({ y: t.year, m: t.month, d: t.day }, format.date)} ${time}`
    : time;
}
