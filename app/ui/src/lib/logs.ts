/** Backfill windows offered for log views, in minutes. */
export const BACKFILL_WINDOWS: { minutes: number; label: string }[] = [
  { minutes: 5, label: "5 min" },
  { minutes: 15, label: "15 min" },
  { minutes: 60, label: "1 h" },
  { minutes: 360, label: "6 h" },
];

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
