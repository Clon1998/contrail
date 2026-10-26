import type { LogColumn, LogEvent } from "@/bindings";
import { usePrefs } from "@/stores/prefs";

/** The optional columns shown (a setting, the same for every view). */
export function useLogColumns(): LogColumn[] {
  return usePrefs((s) => s.prefs.settings.logColumns);
}

/**
 * Fields that hold a correlation ID: `correlationId` or `correlation_id`, alone or under any
 * prefix (frameworks nest it in their own object, e.g. `<framework>.correlationId`).
 */
const CORRELATION_FIELD = /(^|\.)correlation_?id$/i;
/**
 * The fallback without a correlation ID: a trace ID (`trace.id` in ECS, `traceId` / `trace_id` in
 * many APIs, under any prefix), then `log.correlation`.
 */
const TRACE_FIELD = /(^|\.)(trace\.id|trace_?id)$/i;

function correlationValue(fields: LogEvent["line"]["fields"]) {
  for (const pattern of [CORRELATION_FIELD, TRACE_FIELD, /^log\.correlation$/]) {
    const field = fields.find((f) => pattern.test(f.key) && f.value !== "");
    if (field) return field.value;
  }
  return undefined;
}

/** The logger column's width in characters (the list uses a monospace font). */
const LOGGER_CHARS = 22;

export const OPTIONAL_COLUMNS: { id: LogColumn; label: string; width: string }[] = [
  { id: "logger", label: "Logger", width: `${LOGGER_CHARS}ch` },
  { id: "thread", label: "Thread", width: "16ch" },
  { id: "correlation", label: "Correlation / trace ID", width: "18ch" },
];

/** The text of an optional column for an event. */
export function columnValue(event: LogEvent, column: LogColumn): string {
  const field = (key: string) => event.line.fields.find((f) => f.key === key)?.value;
  const value =
    column === "logger"
      ? field("log.logger")
      : column === "thread"
        ? field("process.thread.name")
        : correlationValue(event.line.fields);
  return value === undefined || value === null ? "" : String(value);
}

/** The text shown in an optional column: the logger name shortened, the others as they are. */
export function columnText(event: LogEvent, column: LogColumn): string {
  const value = columnValue(event, column);
  return column === "logger" ? abbreviateLogger(value, LOGGER_CHARS) : value;
}

/**
 * A logger name shortened to `max` characters the way Spring Boot (Logback) does it: package
 * names become their first letter from the left until it fits (`c.e.orders.OrderService`), the
 * class name stays whole. If even that is too long, the front is cut off (`…derServiceImpl`),
 * since the end of a logger name tells the most.
 */
export function abbreviateLogger(name: string, max: number): string {
  if (name.length <= max) return name;
  const parts = name.split(".");
  let length = name.length;
  for (let i = 0; i < parts.length - 1 && length > max; i++) {
    const part = parts[i] ?? "";
    if (part.length <= 1) continue;
    length -= part.length - 1;
    parts[i] = part.charAt(0);
  }
  const short = parts.join(".");
  return short.length <= max ? short : `…${short.slice(short.length - max + 1)}`;
}

/** The CSS grid columns of a row: time, level, [task], [optional…], message. */
export function gridTemplate(showTask: boolean, columns: LogColumn[]): string {
  return [
    "1.2em",
    "12.5ch",
    "6ch",
    ...(showTask ? ["10.5ch"] : []),
    ...OPTIONAL_COLUMNS.filter((c) => columns.includes(c.id)).map((c) => c.width),
    "minmax(0, 1fr)",
  ].join(" ");
}
