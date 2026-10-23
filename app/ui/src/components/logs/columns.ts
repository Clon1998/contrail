import type { LogColumn, LogEvent } from "@/bindings";
import { usePrefs } from "@/stores/prefs";

/** The optional columns shown (a setting, the same for every view). */
export function useLogColumns(): LogColumn[] {
  return usePrefs((s) => s.prefs.settings.logColumns);
}

/** Field names that hold a correlation/trace ID, in order of preference. */
const CORRELATION_FIELDS = [
  "pipeline.correlationId",
  "correlationId",
  "trace.id",
  "log.correlation",
];

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
        : CORRELATION_FIELDS.map(field).find((v) => v !== undefined);
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
