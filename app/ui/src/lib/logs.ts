import type { LiveState, TimeWindow, TimeZone } from "@/bindings";

/** Backfill windows offered for log views, in minutes. */
export const BACKFILL_WINDOWS: { minutes: number; label: string }[] = [
  { minutes: 5, label: "5 min" },
  { minutes: 15, label: "15 min" },
  { minutes: 60, label: "1 h" },
  { minutes: 360, label: "6 h" },
];

/** Windows up to this long follow new events right away; longer ones open paused. */
export const LIVE_BY_DEFAULT_MINUTES = 15;

/**
 * Whether a view of `timeWindow` follows new events: right away ("live"), after the user resumes
 * ("paused"; looking at the past rarely needs a live tail, which AWS bills per minute), or not
 * at all ("off": a fixed range in the past).
 */
export function liveMode(timeWindow: TimeWindow): "live" | "paused" | "off" {
  if (timeWindow.kind === "range") return "off";
  return timeWindow.minutes <= LIVE_BY_DEFAULT_MINUTES ? "live" : "paused";
}

/**
 * The tooltip of the live tail's state chip: what is happening and what the user can do. The
 * backend's message (e.g. why it polls) wins when there is one.
 */
export function liveHint(live: {
  state: LiveState;
  message: string | null;
  userPaused: boolean;
  autoPaused: boolean;
  mode: "live" | "paused" | "off";
}): string {
  if (live.message) return live.message;
  switch (live.state) {
    case "connecting":
      return "Connecting to CloudWatch Live Tail; new events follow in a moment.";
    case "live":
      return "Following new events (CloudWatch Live Tail, billed per session minute). Pause stops the session.";
    case "polling":
      return "Live Tail isn't available: checking for new events every 2 seconds instead.";
    case "reconnecting":
      return "The Live Tail session ended: reconnecting and catching up on what was logged meanwhile.";
    case "failed":
      return "The live tail stopped. Retry to start it again.";
    case "paused":
      if (live.autoPaused && !live.userPaused) {
        return "Paused while Contrail is hidden or the tab is in the background (see the live tail settings). It resumes when you're back.";
      }
      if (live.mode === "paused") {
        return `Paused. Time windows longer than ${LIVE_BY_DEFAULT_MINUTES} minutes start paused; Resume catches up and follows new events.`;
      }
      return "Paused. Resume catches up and follows new events.";
  }
}

export function sameWindow(a: TimeWindow, b: TimeWindow): boolean {
  return a.kind === "last"
    ? b.kind === "last" && a.minutes === b.minutes
    : b.kind === "range" && a.from === b.from && a.to === b.to;
}

/** An ISO time as the value of an `<input type="datetime-local">` (`2026-10-22T08:15`). */
export function toDateTimeLocal(iso: string, timeZone: TimeZone): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const parts =
    timeZone === "utc"
      ? [
          date.getUTCFullYear(),
          date.getUTCMonth(),
          date.getUTCDate(),
          date.getUTCHours(),
          date.getUTCMinutes(),
        ]
      : [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()];
  const [y, mo, d, h, mi] = parts as [number, number, number, number, number];
  return `${y}-${pad(mo + 1)}-${pad(d)}T${pad(h)}:${pad(mi)}`;
}

/** The value of an `<input type="datetime-local">` as an ISO time, or `null` when empty/invalid. */
export function fromDateTimeLocal(value: string, timeZone: TimeZone): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [y, mo, d, h, mi] = match.slice(1).map(Number) as [number, number, number, number, number];
  const date =
    timeZone === "utc" ? new Date(Date.UTC(y, mo - 1, d, h, mi)) : new Date(y, mo - 1, d, h, mi);
  return date.toISOString();
}

/** `11:11` for today, `22 Oct, 08:05` for other days, in local time or UTC. */
export function formatShortTime(timestamp: string, timeZone: TimeZone, now = Date.now()): string {
  const zone = timeZone === "utc" ? "UTC" : undefined;
  const day = (ms: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: zone, dateStyle: "short" }).format(ms);
  const date = Date.parse(timestamp);
  if (Number.isNaN(date)) return "";
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  if (day(date) === day(now)) return time;
  const dayMonth = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    day: "numeric",
    month: "short",
  }).format(date);
  return `${dayMonth}, ${time}`;
}

/** Whether `ms` falls on today's date, in local time or UTC. */
export function isToday(ms: number, timeZone: TimeZone, now = Date.now()): boolean {
  const day = (t: number) => {
    const d = new Date(t);
    return timeZone === "utc"
      ? d.toISOString().slice(0, 10)
      : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };
  return day(ms) === day(now);
}

/** An instant's date and time parts, in local time or UTC. */
function timeParts(timestamp: string, timeZone: TimeZone) {
  const date = new Date(timestamp);
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
 * `12:34:56.789` in local time or UTC (the time zone setting); `10-26 12:34:56.789` with
 * `withDate` (a list decides once for all its rows, so the column keeps one width).
 */
export function formatLogTime(timestamp: string, timeZone: TimeZone, withDate = false): string {
  const t = timeParts(timestamp, timeZone);
  const time = `${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}.${pad(t.ms, 3)}`;
  return withDate ? `${pad(t.month)}-${pad(t.day)} ${time}` : time;
}

/** `2026-10-26 12:34:56.789 UTC` (or `local`): the whole timestamp, for the details. */
export function formatFullTime(timestamp: string, timeZone: TimeZone): string {
  const year = timeParts(timestamp, timeZone).year;
  return `${year}-${formatLogTime(timestamp, timeZone, true)} ${timeZone === "utc" ? "UTC" : "local"}`;
}

/** The text without ANSI colour codes (the debug view shows plain text). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

/** How a stack trace line is shown. */
export type TraceLineKind = "header" | "frame" | "causedBy" | "omitted" | "other";

/** Classifies the lines of a Java stack trace (for highlighting `Caused by:`, dimming `... N more`). */
export function classifyTrace(trace: string): { text: string; kind: TraceLineKind }[] {
  return trace
    .replace(/\n+$/, "")
    .split("\n")
    .map((text, index) => {
      const trimmed = text.trimStart();
      const kind: TraceLineKind =
        index === 0
          ? "header"
          : trimmed.startsWith("at ")
            ? "frame"
            : trimmed.startsWith("Caused by:") || trimmed.startsWith("Suppressed:")
              ? "causedBy"
              : /^\.\.\. \d+ (more|common frames omitted)/.test(trimmed)
                ? "omitted"
                : "other";
      return { text, kind };
    });
}

/** JSON text pretty-printed with two spaces, or `null` if it isn't valid JSON. */
export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/** A token of pretty-printed JSON, for syntax colouring. */
export interface JsonToken {
  text: string;
  kind: "key" | "string" | "number" | "literal" | "punctuation";
}

const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:\s]+)/g;

/** Splits (pretty) JSON text into coloured tokens. */
export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  for (const m of text.matchAll(JSON_TOKEN)) {
    if (m[1] !== undefined) {
      tokens.push({ text: m[1], kind: m[2] ? "key" : "string" });
      if (m[2]) tokens.push({ text: m[2], kind: "punctuation" });
    } else if (m[3] !== undefined) tokens.push({ text: m[3], kind: "number" });
    else if (m[4] !== undefined) tokens.push({ text: m[4], kind: "literal" });
    else tokens.push({ text: m[0], kind: "punctuation" });
  }
  return tokens;
}

/** The message split around its embedded JSON (`span` from the parser, in UTF-8 bytes). */
export function splitEmbeddedJson(
  message: string,
  span: [number, number] | null,
): { before: string; json: string; after: string } | null {
  if (!span) return null;
  // The parser counts bytes (Rust strings are UTF-8); JavaScript strings count UTF-16 units.
  const bytes = new TextEncoder().encode(message);
  const decode = (from: number, to?: number) => new TextDecoder().decode(bytes.slice(from, to));
  return { before: decode(0, span[0]), json: decode(span[0], span[1]), after: decode(span[1]) };
}
