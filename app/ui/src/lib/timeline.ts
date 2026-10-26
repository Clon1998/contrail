import type { Timeline } from "@/bindings";

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
 * The time range a drag from `x0` to `x1` (pixels, either direction) covers on a timeline drawn
 * `width` pixels wide, widened to whole buckets: the bars under the drag are inside the range.
 */
export function selectionRange(
  timeline: Timeline,
  x0: number,
  x1: number,
  width: number,
): { from: string; to: string } {
  const count = timeline.buckets.length;
  const bucketAt = (x: number) => Math.min(count - 1, Math.max(0, Math.floor((x / width) * count)));
  const first = bucketAt(Math.min(x0, x1));
  const last = bucketAt(Math.max(x0, x1));
  return {
    from: new Date(bucketRange(timeline, first)[0]).toISOString(),
    to: new Date(bucketRange(timeline, last)[1]).toISOString(),
  };
}

/** A label for a time on the timeline: the time of day, with the date when it spans days. */
export function timelineLabel(ms: number, timeZone: "local" | "utc", withDate: boolean): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const utc = timeZone === "utc";
  const [y, mo, d, h, mi, s] = utc
    ? [
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
        date.getUTCSeconds(),
      ]
    : [
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
      ];
  const time = `${pad(h)}:${pad(mi)}${s !== 0 ? `:${pad(s)}` : ""}`;
  return withDate ? `${y}-${pad(mo + 1)}-${pad(d)} ${time}` : time;
}
