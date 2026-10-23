import { ChevronRightIcon } from "lucide-react";
import { cn } from "cn";
import type { LogEvent } from "@/bindings";
import { shortTaskId } from "@/lib/ecs";
import { highlightSegments } from "@/lib/highlight";
import { formatLogTime, stripAnsi } from "@/lib/logs";
import { useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";
import { Ansi } from "./Ansi";
import { columnValue, OPTIONAL_COLUMNS, useLogColumns } from "./columns";
import { LEVEL_TONE } from "./levels";
import { LogDetails } from "./LogDetails";

/** One log line: time, level, task, optional columns and the message; expands on click. */
export function LogRow({
  event,
  grid,
  showTask,
  marked = false,
  current = false,
}: {
  event: LogEvent;
  grid: string;
  showTask: boolean;
  /** A search match in highlight mode. */
  marked?: boolean;
  /** The match last jumped to. */
  current?: boolean;
}) {
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  const expanded = useLogs((s) => s.expanded[event.seq] ?? false);
  const toggle = useLogs((s) => s.toggleExpanded);
  const columns = useLogColumns();
  const terms = useLogs((s) => s.highlightTerms);
  const { line } = event;
  const firstLine = line.message.split("\n", 1)[0] ?? "";

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => toggle(event.seq)}
        style={{ gridTemplateColumns: grid }}
        className={cn(
          "grid w-full items-baseline gap-x-2 px-3 text-left hover:bg-accent/50",
          expanded && "bg-accent/40",
          line.level === "ERROR" && "bg-destructive/5",
          marked && "bg-primary/10 shadow-[inset_3px_0_0_var(--primary)]",
          current && "bg-primary/25",
        )}
      >
        <ChevronRightIcon
          className={cn("size-3 self-center text-muted-foreground", expanded && "rotate-90")}
        />
        <span className="text-muted-foreground tabular-nums">
          {formatLogTime(event.timestamp, timeZone)}
        </span>
        <span
          className={cn(
            "font-semibold",
            line.level ? LEVEL_TONE[line.level] : "text-muted-foreground",
          )}
        >
          {line.level ?? "·"}
        </span>
        {showTask && (
          <span
            className="truncate rounded bg-muted px-1 text-muted-foreground"
            title={event.taskId}
          >
            {shortTaskId(event.taskId)}
          </span>
        )}
        {OPTIONAL_COLUMNS.filter((c) => columns.includes(c.id)).map((c) => (
          <span
            key={c.id}
            className="truncate text-muted-foreground"
            title={columnValue(event, c.id)}
          >
            {columnValue(event, c.id)}
          </span>
        ))}
        <span className="truncate">
          {terms.length > 0 ? (
            <Highlighted text={stripAnsi(firstLine)} terms={terms} />
          ) : (
            <Ansi text={firstLine} />
          )}
          {line.error?.errorType && (
            <span className="ml-2 text-destructive">{line.error.errorType.split(".").at(-1)}</span>
          )}
        </span>
      </button>
      {expanded && <LogDetails event={event} />}
    </div>
  );
}

/** Text with the search words marked. */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlightSegments(text, terms).map((segment, i) =>
        segment.match ? (
          <mark key={i} className="rounded-sm bg-warning/40 text-foreground">
            {segment.text}
          </mark>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  );
}
