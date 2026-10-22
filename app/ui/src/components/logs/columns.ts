import type { LogEvent } from "@/bindings";
import type { OptionalColumn } from "@/stores/logs";

/** Field names that hold a correlation/trace ID, in order of preference. */
const CORRELATION_FIELDS = [
  "pipeline.correlationId",
  "correlationId",
  "trace.id",
  "log.correlation",
];

export const OPTIONAL_COLUMNS: { id: OptionalColumn; label: string; width: string }[] = [
  { id: "logger", label: "Logger", width: "22ch" },
  { id: "thread", label: "Thread", width: "16ch" },
  { id: "correlation", label: "Correlation / trace ID", width: "18ch" },
];

/** The text of an optional column for an event. */
export function columnValue(event: LogEvent, column: OptionalColumn): string {
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
export function gridTemplate(showTask: boolean, columns: Record<OptionalColumn, boolean>): string {
  return [
    "1.2em",
    "12.5ch",
    "6ch",
    ...(showTask ? ["10.5ch"] : []),
    ...OPTIONAL_COLUMNS.filter((c) => columns[c.id]).map((c) => c.width),
    "minmax(0, 1fr)",
  ].join(" ");
}
