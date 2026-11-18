import type { ClockFormat, DateFormat, TimeZone } from "@/bindings";

/** How absolute times are shown: the time zone, date format and clock settings together. */
export interface TimeFormat {
  timeZone: TimeZone;
  date: DateFormat;
  clock: ClockFormat;
}

export const DEFAULT_TIME_FORMAT: TimeFormat = { timeZone: "local", date: "iso", clock: "h24" };

/** An instant's date and time parts, in local time or UTC. */
export interface TimeParts {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

export function timeParts(ms: number, timeZone: TimeZone): TimeParts {
  const date = new Date(ms);
  const utc = timeZone === "utc";
  return {
    year: utc ? date.getUTCFullYear() : date.getFullYear(),
    month: (utc ? date.getUTCMonth() : date.getMonth()) + 1,
    day: utc ? date.getUTCDate() : date.getDate(),
    hour: utc ? date.getUTCHours() : date.getHours(),
    minute: utc ? date.getUTCMinutes() : date.getMinutes(),
    second: utc ? date.getUTCSeconds() : date.getSeconds(),
    ms: utc ? date.getUTCMilliseconds() : date.getMilliseconds(),
  };
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/**
 * A date in numbers: `2026-11-18`, `18.11.2026` or `11/18/2026`; without the year `11-18`,
 * `18.11.` or `11/18`.
 */
export function formatDate(
  day: { y: number; m: number; d: number },
  format: DateFormat,
  withYear = true,
): string {
  const { y, m, d } = day;
  switch (format) {
    case "iso":
      return withYear ? `${y}-${pad(m)}-${pad(d)}` : `${pad(m)}-${pad(d)}`;
    case "dayMonthYear":
      return withYear ? `${pad(d)}.${pad(m)}.${y}` : `${pad(d)}.${pad(m)}.`;
    case "monthDayYear":
      return withYear ? `${pad(m)}/${pad(d)}/${y}` : `${pad(m)}/${pad(d)}`;
  }
}

const MONTH_ABBR = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/**
 * A date with the month in words, for labels: `18 Nov` (day first, with `dayMonthYear`) or
 * `Nov 18`; with the year `18 Nov 2025` or `Nov 18, 2025`.
 */
export function formatDayName(
  day: { y: number; m: number; d: number },
  format: DateFormat,
  withYear = false,
): string {
  const month = MONTH_ABBR[day.m - 1] ?? "";
  if (format === "dayMonthYear") {
    return withYear ? `${day.d} ${month} ${day.y}` : `${day.d} ${month}`;
  }
  return withYear ? `${month} ${day.d}, ${day.y}` : `${month} ${day.d}`;
}

/**
 * A time of day: `14:05` or `2:05 PM`, with `seconds` `14:05:07`, with `ms` `14:05:07.123`.
 * `fixedWidth` pads 12-hour times to `02:05 PM`, so a column of them lines up.
 */
export function formatClock(
  t: Pick<TimeParts, "hour" | "minute" | "second" | "ms">,
  clock: ClockFormat,
  options: { seconds?: boolean; ms?: boolean; fixedWidth?: boolean } = {},
): string {
  const seconds = options.seconds || options.ms;
  const rest = `${pad(t.minute)}${seconds ? `:${pad(t.second)}` : ""}${options.ms ? `.${pad(t.ms, 3)}` : ""}`;
  if (clock === "h24") return `${pad(t.hour)}:${rest}`;
  const hour = t.hour % 12 === 0 ? 12 : t.hour % 12;
  const half = t.hour < 12 ? "AM" : "PM";
  return `${options.fixedWidth ? pad(hour) : hour}:${rest} ${half}`;
}
