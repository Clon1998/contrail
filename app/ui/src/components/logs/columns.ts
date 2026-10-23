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
/** Fallbacks when there is no correlation ID, in order of preference. */
const TRACE_FIELDS = ["trace.id", "log.correlation"];

function correlationValue(fields: LogEvent["line"]["fields"]) {
  const correlation = fields.find((f) => CORRELATION_FIELD.test(f.key) && f.value !== "");
  if (correlation) return correlation.value;
  for (const key of TRACE_FIELDS) {
    const field = fields.find((f) => f.key === key);
    if (field) return field.value;
  }
  return undefined;
}

export const OPTIONAL_COLUMNS: { id: LogColumn; label: string; width: string }[] = [
  { id: "logger", label: "Logger", width: "22ch" },
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
