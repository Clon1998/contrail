import { useEffect, useState } from "react";
import { ChevronRightIcon, CircleAlertIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { cn } from "cn";
import type { Level, LogEvent } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { shortTaskId } from "@/lib/ecs";
import { BACKFILL_WINDOWS, formatLogTime, stripAnsi } from "@/lib/logs";
import { useEcs } from "@/stores/ecs";
import { DEBUG_ROW_LIMIT, useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";

const LEVEL_TONE: Record<Level, string> = {
  ERROR: "text-destructive",
  WARN: "text-warning",
  INFO: "text-foreground",
  DEBUG: "text-muted-foreground",
  TRACE: "text-muted-foreground/70",
};

const LEVELS: Level[] = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"];

/**
 * A simple list of the service's backfilled logs (milestone M3's debug view). The real viewer
 * (virtual scrolling, columns, search) replaces it in M4.
 */
export function LogsPanel() {
  const ctx = useEcs((s) => s.ctx);
  const selected = useEcs((s) => s.selected);
  const defaultMinutes = usePrefs((s) => s.prefs.settings.backfillMinutes);
  const [minutes, setMinutes] = useState(defaultMinutes);
  const { view, rows, loading, error, open, close } = useLogs();

  useEffect(() => {
    if (ctx && selected) void open(ctx, selected, minutes);
  }, [ctx, selected, minutes, open]);

  // Free the view's buffer in Rust when the panel goes away.
  useEffect(() => () => void close(), [close]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <div
          role="radiogroup"
          aria-label="Time window"
          className="flex rounded-md border border-border p-0.5"
        >
          {BACKFILL_WINDOWS.map((w) => (
            <button
              key={w.minutes}
              type="button"
              role="radio"
              aria-checked={w.minutes === minutes}
              onClick={() => setMinutes(w.minutes)}
              className={cn(
                "rounded px-2 py-0.5",
                w.minutes === minutes
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Reload logs"
          disabled={loading || !ctx || !selected}
          onClick={() => ctx && selected && void open(ctx, selected, minutes)}
        >
          <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
        </Button>
        {view && (
          <>
            <span className="text-muted-foreground" title={view.location.logGroup}>
              {`${view.location.logGroup} · ${view.streams} streams`}
            </span>
            <span className="ml-auto flex items-center gap-2" aria-label="Level counts">
              {LEVELS.map((level) => (
                <span key={level} className={LEVEL_TONE[level]}>
                  {level} {view.stats[level.toLowerCase() as Lowercase<Level>]}
                </span>
              ))}
            </span>
            {view.truncated && <Badge variant="outline">truncated</Badge>}
          </>
        )}
      </div>

      {error && (
        <p className="mx-4 mt-3 flex items-start gap-2 text-sm text-destructive">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span>
            {error.message}
            {error.hint && <span className="block text-muted-foreground">{error.hint}</span>}
          </span>
        </p>
      )}
      {loading && (
        <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" /> Loading logs…
        </p>
      )}
      {!loading && view && rows.length === 0 && (
        <p className="p-4 text-sm text-muted-foreground">No log events in this time window.</p>
      )}
      {!loading && rows.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto">
          {view && view.stats.total > rows.length && (
            <p className="px-4 py-1 text-xs text-muted-foreground">
              Showing the newest {DEBUG_ROW_LIMIT.toLocaleString()} of{" "}
              {view.stats.total.toLocaleString()} events.
            </p>
          )}
          <ol aria-label="Log events" className="font-mono text-(length:--log-font-size)">
            {rows.map((event) => (
              <LogRow key={event.seq} event={event} />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function LogRow({ event }: { event: LogEvent }) {
  const [open, setOpen] = useState(false);
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  const { line } = event;
  const firstLine = stripAnsi(line.message).split("\n")[0];

  return (
    <li className="border-b border-border/40">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-baseline gap-2 px-4 py-0.5 text-left hover:bg-accent/50"
      >
        <ChevronRightIcon
          className={cn("size-3 shrink-0 self-center text-muted-foreground", open && "rotate-90")}
        />
        <span className="shrink-0 text-muted-foreground">
          {formatLogTime(event.timestamp, timeZone)}
        </span>
        <span
          className={cn(
            "w-12 shrink-0 font-semibold",
            line.level ? LEVEL_TONE[line.level] : "text-muted-foreground",
          )}
        >
          {line.level ?? "—"}
        </span>
        <span className="shrink-0 rounded bg-muted px-1 text-muted-foreground" title={event.taskId}>
          {shortTaskId(event.taskId)}
        </span>
        <span className="truncate">{firstLine}</span>
        {line.error && (
          <span className="shrink-0 text-destructive">
            {line.error.errorType?.split(".").at(-1)}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-2 bg-muted/30 px-10 py-2">
          {line.message.includes("\n") && (
            <pre className="whitespace-pre-wrap">{stripAnsi(line.message)}</pre>
          )}
          {line.fields.length > 0 && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5">
              {line.fields.map((field) => (
                <div key={field.key} className="contents">
                  <dt className="text-muted-foreground">{field.key}</dt>
                  <dd className="break-all">{String(field.value)}</dd>
                </div>
              ))}
            </dl>
          )}
          {line.error?.stackTrace && (
            <pre
              aria-label="Stack trace"
              className="overflow-x-auto whitespace-pre text-destructive/90"
            >
              {line.error.stackTrace}
            </pre>
          )}
          <p className="text-muted-foreground">
            {line.kind} · {event.stream}
          </p>
        </div>
      )}
    </li>
  );
}
