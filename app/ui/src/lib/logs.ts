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

/** `15 min`, `2 h`, `3 d`, or `10-22 08:00 – 10-22 09:30` for a fixed range. */
export function windowLabel(timeWindow: TimeWindow, timeZone: TimeZone): string {
  if (timeWindow.kind === "range") {
    const short = (iso: string) => toDateTimeLocal(iso, timeZone).slice(5).replace("T", " ");
    return `${short(timeWindow.from)} – ${short(timeWindow.to)}`;
  }
  const { minutes } = timeWindow;
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
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

/** `12:34:56.789` in local time or UTC (the time zone setting). */
export function formatLogTime(timestamp: string, timeZone: "local" | "utc"): string {
  const date = new Date(timestamp);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const [h, m, s, ms] =
    timeZone === "utc"
      ? [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()]
      : [date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()];
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
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
