import type { TimeWindow, TimeZone } from "@/bindings";
import { fromDateTimeLocal, toDateTimeLocal } from "@/lib/logs";

/**
 * Typed time windows, for the time picker: what the user typed, read as a window.
 *
 * - Durations: `15m`, `3h`, `2d`, `1w`, `1h30m`, `90` (minutes), `last 2 hours`
 * - Since a point in time (followed live like any "last …" window): `today`, `since 14:00`,
 *   `since yesterday 9:00`
 * - Fixed ranges: `yesterday`, `2026-10-23`, `oct 23`, `9:00-11:30`, `yesterday 9-11`,
 *   `oct 22 22:00 - oct 23 2:00`, `2pm-3pm`
 *
 * Days and times are in the user's time zone setting (local time or UTC).
 */
export type TimeInput =
  | { kind: "empty" }
  | { kind: "invalid"; hint: string }
  | {
      kind: "ok";
      window: TimeWindow;
      /** What the user meant, when that says more than the window (`Today`, `Since 14:00`). */
      title?: string;
    };

const MINUTE = 60_000;
const UNITS: Record<string, number> = {
  m: 1,
  min: 1,
  mins: 1,
  minute: 1,
  minutes: 1,
  h: 60,
  hr: 60,
  hrs: 60,
  hour: 60,
  hours: 60,
  d: 1440,
  day: 1440,
  days: 1440,
  w: 10080,
  wk: 10080,
  wks: 10080,
  week: 10080,
  weeks: 10080,
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A calendar day in the user's time zone. */
interface Day {
  y: number;
  m: number; // 1–12
  d: number;
}

const DAY = String.raw`today|yesterday|\d{4}-\d{1,2}-\d{1,2}|[a-z]{3,9}\.? \d{1,2}|\d{1,2}\.? [a-z]{3,9}`;
const TIME = String.raw`\d{1,2}(?::\d{2})? ?(?:am|pm)?`;
const RANGE = new RegExp(`^(?:(${DAY}) )?(${TIME}) ?- ?(?:(${DAY}) )?(${TIME})$`);
const SINCE = new RegExp(`^(?:since|from) (?:(${DAY})(?: (${TIME}))?|(${TIME}))$`);
const DURATION = /^(?:(?:last|past) )?((?:\d+(?:\.\d+)? ?[a-z]+ ?)+)$/;

export function parseTimeInput(text: string, timeZone: TimeZone, now = Date.now()): TimeInput {
  const input = text
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+to\s+/g, " - ")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (input === "") return { kind: "empty" };

  // `90` alone: minutes.
  if (/^\d+$/.test(input)) return last(Number(input));

  const minutes = parseDuration(input);
  if (minutes !== null) return last(minutes);

  const today = dayOf(now, timeZone);
  if (input === "today") return since(at(today, 0, 0, timeZone), now, "Today");

  const since_ = SINCE.exec(input);
  if (since_) {
    const [, dayText, timeText, timeOnly] = since_;
    const time = parseTime(timeOnly ?? timeText ?? "0");
    // A time without a day that hasn't come yet today is yesterday's (`since 9:00` at 2:00).
    const day = dayText
      ? parseDay(dayText, today)
      : time && at(today, time.h, time.m, timeZone) > now
        ? addDays(today, -1)
        : today;
    if (!day || !time) return invalid("Try since 14:00 or since yesterday 9:00.");
    const start = at(day, time.h, time.m, timeZone);
    const title = sameDay(day, today)
      ? `Since ${clock(start, timeZone)}`
      : `Since ${dayName(day, today)} ${clock(start, timeZone)}`;
    return since(start, now, title);
  }

  const range = RANGE.exec(input);
  if (range) {
    const [, fromDayText, fromText, toDayText, toText] = range;
    const from = parseTime(fromText ?? "");
    const to = parseTime(toText ?? "");
    // Like `since`: a range that hasn't started yet today is yesterday's.
    const fromDay = fromDayText
      ? parseDay(fromDayText, today)
      : from && at(today, from.h, from.m, timeZone) > now
        ? addDays(today, -1)
        : today;
    const toDay = toDayText ? parseDay(toDayText, today) : fromDay;
    if (!fromDay || !toDay || !from || !to) return invalid("Try 9:00-11:30 or yesterday 9-11.");
    const start = at(fromDay, from.h, from.m, timeZone);
    let end = at(toDay, to.h, to.m, timeZone);
    // `22:00-2:00` ends on the next day.
    if (!toDayText && end <= start) end = at(addDays(toDay, 1), to.h, to.m, timeZone);
    return fixed(start, end, now);
  }

  const day = parseDay(input, today);
  if (day) {
    if (sameDay(day, today)) return since(at(today, 0, 0, timeZone), now, "Today");
    return fixed(at(day, 0, 0, timeZone), at(addDays(day, 1), 0, 0, timeZone), now);
  }

  return invalid("Try 15m, 3h, 2d, today, yesterday, since 14:00 or 9:00-11:30.");
}

/** `15m`, `1h30m`, `last 2 hours` in minutes; `null` for anything else (`23 oct` is a day). */
function parseDuration(input: string): number | null {
  const duration = DURATION.exec(input);
  if (!duration) return null;
  let minutes = 0;
  for (const [, amount, unit] of (duration[1] ?? "").matchAll(/(\d+(?:\.\d+)?) ?([a-z]+)/g)) {
    const factor = UNITS[unit ?? ""];
    if (factor === undefined) return null;
    minutes += Number(amount) * factor;
  }
  return minutes;
}

function invalid(hint: string): TimeInput {
  return { kind: "invalid", hint };
}

function last(minutes: number): TimeInput {
  const rounded = Math.round(minutes);
  if (!Number.isFinite(rounded) || rounded < 1) return invalid("At least one minute.");
  return { kind: "ok", window: { kind: "last", minutes: rounded } };
}

/** From `start` until now, as a "last …" window (so it can follow live). */
function since(start: number, now: number, title: string): TimeInput {
  if (start >= now) return invalid("That's in the future.");
  const result = last(Math.ceil((now - start) / MINUTE));
  return result.kind === "ok" ? { ...result, title } : result;
}

function fixed(start: number, end: number, now: number): TimeInput {
  if (start >= now) return invalid("That's in the future.");
  if (end <= start) return invalid("The end is before the start.");
  return {
    kind: "ok",
    window: { kind: "range", from: new Date(start).toISOString(), to: new Date(end).toISOString() },
  };
}

/** `9`, `09:30`, `2pm`, `2:30 pm` as hours and minutes. */
function parseTime(text: string): { h: number; m: number } | null {
  const match = /^(\d{1,2})(?::(\d{2}))? ?(am|pm)?$/.exec(text.trim());
  if (!match) return null;
  let h = Number(match[1]);
  const m = Number(match[2] ?? 0);
  const half = match[3];
  if (half) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (half === "pm" ? 12 : 0);
  }
  return h < 24 && m < 60 ? { h, m } : null;
}

/** `today`, `yesterday`, `2026-10-23`, `oct 23`, `23 oct`: a day not after today. */
function parseDay(text: string, today: Day): Day | null {
  if (text === "today") return today;
  if (text === "yesterday") return addDays(today, -1);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return validDay({ y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) });
  const monthFirst = /^([a-z]{3,9})\.? (\d{1,2})$/.exec(text);
  const dayFirst = /^(\d{1,2})\.? ([a-z]{3,9})$/.exec(text);
  const [monthName, dayNumber] = monthFirst
    ? [monthFirst[1], monthFirst[2]]
    : dayFirst
      ? [dayFirst[2], dayFirst[1]]
      : [];
  if (!monthName || !dayNumber) return null;
  const month = MONTHS.indexOf(monthName.slice(0, 3)) + 1;
  if (month === 0) return null;
  // Without a year: the last such day, this year or the year before.
  const thisYear = validDay({ y: today.y, m: month, d: Number(dayNumber) });
  if (!thisYear) return null;
  return compareDays(thisYear, today) > 0 ? validDay({ ...thisYear, y: today.y - 1 }) : thisYear;
}

function validDay(day: Day): Day | null {
  const date = new Date(Date.UTC(day.y, day.m - 1, day.d));
  return date.getUTCMonth() === day.m - 1 && date.getUTCDate() === day.d ? day : null;
}

/** The calendar day of `ms` in the time zone. */
export function dayOf(ms: number, timeZone: TimeZone): Day {
  const [y, m, d] = toDateTimeLocal(new Date(ms).toISOString(), timeZone)
    .slice(0, 10)
    .split("-")
    .map(Number) as [number, number, number];
  return { y, m, d };
}

export function addDays(day: Day, days: number): Day {
  const date = new Date(Date.UTC(day.y, day.m - 1, day.d + days));
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

export function compareDays(a: Day, b: Day): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

export function sameDay(a: Day, b: Day): boolean {
  return compareDays(a, b) === 0;
}

/** The time `h:m` on `day`, in ms. */
export function at(day: Day, h: number, m: number, timeZone: TimeZone): number {
  const pad = (n: number) => String(n).padStart(2, "0");
  const local = `${day.y}-${pad(day.m)}-${pad(day.d)}T${pad(h)}:${pad(m)}`;
  return Date.parse(fromDateTimeLocal(local, timeZone) ?? "");
}

export type { Day };

/** `15 min`, `1 h 30 min`, `2 d` (short) or `15 minutes`, `24 hours`, `2 days` (long). */
export function durationText(minutes: number, style: "short" | "long"): string {
  // Days only from two of them: `24 hours` reads better than `1 day`.
  const days = minutes >= 2880 ? Math.floor(minutes / 1440) : 0;
  const parts: [number, string, string][] = [
    [days, "d", "day"],
    [Math.floor((minutes - days * 1440) / 60), "h", "hour"],
    [minutes % 60, "min", "minute"],
  ];
  const shown = parts.filter(([n]) => n > 0).slice(0, 2);
  return shown
    .map(([n, short, long]) =>
      style === "short" ? `${n} ${short}` : `${n} ${long}${n === 1 ? "" : "s"}`,
    )
    .join(" ");
}

/** `Today`, `Yesterday`, `Oct 20`, or `Dec 24, 2025` in another year. */
function dayName(day: Day, today: Day): string {
  if (sameDay(day, today)) return "Today";
  if (sameDay(day, addDays(today, -1))) return "Yesterday";
  const month = MONTHS[day.m - 1] ?? "";
  const name = `${month.charAt(0).toUpperCase()}${month.slice(1)} ${day.d}`;
  return day.y === today.y ? name : `${name}, ${day.y}`;
}

function clock(ms: number, timeZone: TimeZone): string {
  return toDateTimeLocal(new Date(ms).toISOString(), timeZone).slice(11, 16);
}

/**
 * What a window covers, in words: `Last 15 minutes`, `Yesterday`, `Yesterday 09:00 → 11:00`,
 * `Oct 22 22:00 → Oct 23 02:00`.
 */
export function windowTitle(window: TimeWindow, timeZone: TimeZone, now = Date.now()): string {
  if (window.kind === "last") return `Last ${durationText(window.minutes, "long")}`;
  const today = dayOf(now, timeZone);
  const from = Date.parse(window.from);
  // A range ending at midnight belongs to the day before (`Yesterday`, not `… → Today 00:00`).
  const to = Date.parse(window.to);
  const fromDay = dayOf(from, timeZone);
  const lastDay = dayOf(to - 1, timeZone);
  const wholeDays = clock(from, timeZone) === "00:00" && clock(to, timeZone) === "00:00";
  if (wholeDays) {
    return sameDay(fromDay, lastDay)
      ? dayName(fromDay, today)
      : `${dayName(fromDay, today)} → ${dayName(lastDay, today)}`;
  }
  const toDay = dayOf(to, timeZone);
  const end = sameDay(fromDay, toDay)
    ? clock(to, timeZone)
    : `${dayName(toDay, today)} ${clock(to, timeZone)}`;
  return `${dayName(fromDay, today)} ${clock(from, timeZone)} → ${end}`;
}

/** The label of the time picker's button: `Last 15 min`, or the range's title. */
export function windowChip(window: TimeWindow, timeZone: TimeZone, now = Date.now()): string {
  return window.kind === "last"
    ? `Last ${durationText(window.minutes, "short")}`
    : windowTitle(window, timeZone, now);
}

/** The other half of the picture: where a "last" window starts, or how long a range is. */
export function windowDetail(window: TimeWindow, timeZone: TimeZone, now = Date.now()): string {
  if (window.kind === "range") {
    const minutes = Math.round((Date.parse(window.to) - Date.parse(window.from)) / MINUTE);
    return durationText(minutes, "long");
  }
  const start = now - window.minutes * MINUTE;
  const day = dayOf(start, timeZone);
  const today = dayOf(now, timeZone);
  return sameDay(day, today)
    ? `since ${clock(start, timeZone)}`
    : `since ${dayName(day, today)} ${clock(start, timeZone)}`;
}
